// The send gate (V6 P1 S4.5; spec §2.13, Product_V6 §12.4 / §23.7 rule 2;
// GoldenEvals V6 P1 §5.14 GATE-A).
//
// The daemon is the last thing between a decision and a real message leaving
// the user's phone number, and it refuses to be a courier. A `send_message`
// is admitted ONLY when it carries an approval token that:
//
//  1. is present and parses as a SuperTwin approval token (GATE-A-01),
//  2. carries a valid HMAC under this install's approval key — so a token the
//     daemon has never seen, minted by nobody, is a forgery it can detect on
//     its own without reading the worker's database,
//  3. names the send action this daemon performs ("whatsapp.send"),
//  4. has not expired,
//  5. commits to EXACTLY this recipient and EXACTLY this text — Rohan's token
//     cannot send to Karan, and cannot send Rohan a different sentence
//     (GATE-A-02), and
//  6. has not already driven a send through this process (replay).
//
// The key arrives as SUPERTWIN_APPROVAL_KEY in the spawn environment (the
// worker's approvals/key.ts owns the file it comes from). Without a key the
// daemon cannot verify anything, so it refuses every send: an unverifiable
// gate is an open gate, and this one fails closed.
//
// Token format, mirrored exactly from worker/src/approvals/tokens.ts:
//
//	st1~<action>~<id>~<expiresAtMs>~<bindDigest|->~<sigHex>
//	sig        = HMAC-SHA256(key, "st1~<action>~<id>~<expiresAtMs>~<bindDigest>")
//	bindDigest = SHA256("st1\n" + SHA256(to) + "\n" + SHA256(text))  [hex]
package daemon

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	tokenVersion = "st1"
	tokenSep     = "~"
	tokenUnbound = "-"

	// ApprovalKeyEnv carries the install's approval-signing secret (hex).
	ApprovalKeyEnv = "SUPERTWIN_APPROVAL_KEY"
	// ApprovalActionEnv overrides the action this daemon accepts tokens for.
	ApprovalActionEnv = "SUPERTWIN_APPROVAL_ACTION"

	defaultSendAction = "whatsapp.send"
)

// parsedToken is one approval token's fields, before any verification.
type parsedToken struct {
	action      string
	id          string
	expiresAtMs int64
	bindDigest  string // "" when the token commits to no payload
	sig         string
}

func isHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func isAction(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if i > 0 {
			ok = ok || c == '.' || c == '_' || c == '-'
		}
		if !ok {
			return false
		}
	}
	return true
}

// parseToken splits a token string. ok=false for anything that is not our
// format — no allocation of trust, just of fields.
func parseToken(token string) (parsedToken, bool) {
	parts := strings.Split(token, tokenSep)
	if len(parts) != 6 {
		return parsedToken{}, false
	}
	if parts[0] != tokenVersion {
		return parsedToken{}, false
	}
	if !isAction(parts[1]) || !isHex(parts[2], 32) || !isHex(parts[5], 64) {
		return parsedToken{}, false
	}
	exp, err := strconv.ParseInt(parts[3], 10, 64)
	if err != nil || exp <= 0 {
		return parsedToken{}, false
	}
	digest := parts[4]
	if digest != tokenUnbound && !isHex(digest, 64) {
		return parsedToken{}, false
	}
	if digest == tokenUnbound {
		digest = ""
	}
	return parsedToken{action: parts[1], id: parts[2], expiresAtMs: exp, bindDigest: digest, sig: parts[5]}, true
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// BindingDigest is the payload digest a send token must commit to. Each field
// is hashed on its own before being joined, so no recipient/text pair can be
// re-cut into another.
func BindingDigest(to, text string) string {
	return sha256Hex(tokenVersion + "\n" + sha256Hex(to) + "\n" + sha256Hex(text))
}

func signingMaterial(p parsedToken) string {
	digest := p.bindDigest
	if digest == "" {
		digest = tokenUnbound
	}
	return strings.Join([]string{tokenVersion, p.action, p.id, strconv.FormatInt(p.expiresAtMs, 10), digest}, tokenSep)
}

// sendGate holds the per-process replay set and the injectable seams the tests
// need (key source and clock).
type sendGate struct {
	mu     sync.Mutex
	seen   map[string]bool
	getenv func(string) string
	now    func() time.Time
}

func newSendGate() *sendGate {
	return &sendGate{seen: map[string]bool{}, getenv: os.Getenv, now: time.Now}
}

// defaultSendGate is the process's gate. One entry per approved send in the
// daemon's lifetime — bounded by how many sends a human taps.
var defaultSendGate = newSendGate()

func (g *sendGate) key() ([]byte, bool) {
	raw := strings.TrimSpace(g.getenv(ApprovalKeyEnv))
	if len(raw) < 32 {
		return nil, false
	}
	b, err := hex.DecodeString(strings.ToLower(raw))
	if err != nil || len(b) < 16 {
		return nil, false
	}
	return b, true
}

func (g *sendGate) action() string {
	if a := strings.TrimSpace(g.getenv(ApprovalActionEnv)); isAction(a) {
		return a
	}
	return defaultSendAction
}

// admit decides whether ONE send_message may proceed. reason is the
// human-readable refusal; ok=true means the token was valid for exactly this
// payload and has now been retired for this process.
//
// A refusal never burns the token: a mistyped recipient must not cost the user
// their approval.
func (g *sendGate) admit(token, to, text string) (reason string, ok bool) {
	if strings.TrimSpace(token) == "" {
		return "approval_token is required (no send path without a minted single-use approval token)", false
	}
	key, haveKey := g.key()
	if !haveKey {
		return fmt.Sprintf("no approval key configured (%s) — the daemon cannot verify a tap, so it sends nothing", ApprovalKeyEnv), false
	}
	p, ok := parseToken(token)
	if !ok {
		return "approval_token is not a SuperTwin approval token", false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingMaterial(p)))
	want := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(p.sig)) {
		return "approval_token signature does not verify (forged, altered, or minted under another install)", false
	}
	if p.action != g.action() {
		return fmt.Sprintf("approval_token is for %q, not %q", p.action, g.action()), false
	}
	if g.now().UnixMilli() >= p.expiresAtMs {
		return "approval_token has expired", false
	}
	if p.bindDigest == "" {
		return "approval_token is not bound to a message (a send token must name its recipient and text)", false
	}
	if !hmac.Equal([]byte(BindingDigest(to, text)), []byte(p.bindDigest)) {
		return "approval_token was approved for a different recipient or a different message", false
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	if g.seen[p.id] {
		return "approval_token already used (single-use)", false
	}
	g.seen[p.id] = true
	return "", true
}

// admitSend is the package-level entry the command dispatcher calls.
func admitSend(token, to, text string) (reason string, ok bool) {
	return defaultSendGate.admit(token, to, text)
}
