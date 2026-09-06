// GATE-A — the send gate, asserted where it matters most: inside the process
// that actually talks to WhatsApp (GoldenEvals V6 P1 §5.14, V6 P1 S4.5).
//
//	GATE-A-01  no token, no send                       — hard, `risky_without_token`
//	GATE-A-02  the token is single-use AND bound        — a replay and a
//	           re-aimed token are both refused
//	GATE-A-03  the token authorizes exactly the approved payload — an edited
//	           message no longer verifies, so the daemon refuses it
//
// These tests mint tokens the same way the worker does (mintTestToken below is
// the Go mirror of worker/src/approvals/tokens.ts), which is itself the check
// that the two implementations agree: a token minted by the mirror must be
// accepted, and one minted under another key must not.
package daemon

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// mintTestToken builds a token exactly as the worker's approvals/tokens.ts
// does. bound=false leaves it committed to no payload.
func mintTestToken(t *testing.T, key, action, id string, expiresAt time.Time, to, text string, bound bool) string {
	t.Helper()
	digest := tokenUnbound
	if bound {
		digest = BindingDigest(to, text)
	}
	exp := strconv.FormatInt(expiresAt.UnixMilli(), 10)
	material := strings.Join([]string{tokenVersion, action, id, exp, digest}, tokenSep)
	raw, err := hex.DecodeString(key)
	if err != nil {
		t.Fatalf("bad test key: %v", err)
	}
	mac := hmac.New(sha256.New, raw)
	mac.Write([]byte(material))
	return material + tokenSep + hex.EncodeToString(mac.Sum(nil))
}

// gateAt returns a gate with a fixed key and a frozen clock.
func gateAt(key string, now time.Time) *sendGate {
	g := newSendGate()
	g.getenv = func(k string) string {
		if k == ApprovalKeyEnv {
			return key
		}
		return ""
	}
	g.now = func() time.Time { return now }
	return g
}

var (
	gateNow = time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	rohan   = "919812345678@s.whatsapp.net"
	karan   = "919800000000@s.whatsapp.net"
	body    = "sending the villa advance tonight"
)

func mustAdmit(t *testing.T, g *sendGate, token, to, text string) {
	t.Helper()
	if reason, ok := g.admit(token, to, text); !ok {
		t.Fatalf("expected the approved payload to be admitted; refused: %s", reason)
	}
}

func mustRefuse(t *testing.T, g *sendGate, token, to, text, want string) {
	t.Helper()
	reason, ok := g.admit(token, to, text)
	if ok {
		t.Fatalf("expected a refusal for %q → %q", to, text)
	}
	if want != "" && !strings.Contains(reason, want) {
		t.Fatalf("refusal should mention %q; got %q", want, reason)
	}
}

// --- GATE-A-01 — no token, no send (hard) -----------------------------------

func TestGateA01NoTokenNoSend(t *testing.T) {
	g := gateAt(testKey, gateNow)
	mustRefuse(t, g, "", rohan, body, "approval_token is required")
	mustRefuse(t, g, "   ", rohan, body, "approval_token is required")
	// Not our format at all: an opaque string a prompt could have produced.
	mustRefuse(t, g, "please-let-me-send", rohan, body, "not a SuperTwin approval token")
	// Right shape, wrong signature — a forgery the daemon detects alone.
	forged := mintTestToken(t, strings.Repeat("ab", 32), "whatsapp.send", strings.Repeat("1", 32),
		gateNow.Add(5*time.Minute), rohan, body, true)
	mustRefuse(t, g, forged, rohan, body, "signature does not verify")
}

func TestGateA01NoKeyRefusesEverything(t *testing.T) {
	// An unverifiable gate is an open gate: without a key the daemon sends
	// nothing at all, not even with a token that would otherwise be perfect.
	good := mintTestToken(t, testKey, "whatsapp.send", strings.Repeat("2", 32),
		gateNow.Add(5*time.Minute), rohan, body, true)
	g := gateAt("", gateNow)
	mustRefuse(t, g, good, rohan, body, "no approval key configured")
	g = gateAt("not-hex-at-all-not-hex-at-all-xx", gateNow)
	mustRefuse(t, g, good, rohan, body, "no approval key configured")
}

func TestGateA01ExpiredAndWrongAction(t *testing.T) {
	g := gateAt(testKey, gateNow)
	stale := mintTestToken(t, testKey, "whatsapp.send", strings.Repeat("3", 32),
		gateNow.Add(-time.Second), rohan, body, true)
	mustRefuse(t, g, stale, rohan, body, "expired")

	other := mintTestToken(t, testKey, "browser.payment", strings.Repeat("4", 32),
		gateNow.Add(5*time.Minute), rohan, body, true)
	mustRefuse(t, g, other, rohan, body, "not \"whatsapp.send\"")

	unbound := mintTestToken(t, testKey, "whatsapp.send", strings.Repeat("5", 32),
		gateNow.Add(5*time.Minute), rohan, body, false)
	mustRefuse(t, g, unbound, rohan, body, "not bound to a message")
}

// --- GATE-A-02 — single-use and bound ---------------------------------------

func TestGateA02TokenIsSingleUse(t *testing.T) {
	g := gateAt(testKey, gateNow)
	tok := mintTestToken(t, testKey, "whatsapp.send", strings.Repeat("6", 32),
		gateNow.Add(5*time.Minute), rohan, body, true)
	mustAdmit(t, g, tok, rohan, body)
	mustRefuse(t, g, tok, rohan, body, "already used")
}

func TestGateA02RohansTokenCannotSendToKaran(t *testing.T) {
	g := gateAt(testKey, gateNow)
	tok := mintTestToken(t, testKey, "whatsapp.send", strings.Repeat("7", 32),
		gateNow.Add(5*time.Minute), rohan, body, true)

	// Re-aimed at another person: refused, and NOT burned — a misdirected
	// attempt must not cost the user the approval they actually gave.
	mustRefuse(t, g, tok, karan, body, "different recipient or a different message")
	mustAdmit(t, g, tok, rohan, body)
}

// --- GATE-A-03 — exactly what the card showed -------------------------------

func TestGateA03EditingInvalidatesTheToken(t *testing.T) {
	g := gateAt(testKey, gateNow)
	tok := mintTestToken(t, testKey, "whatsapp.send", strings.Repeat("8", 32),
		gateNow.Add(5*time.Minute), rohan, body, true)

	// One character added after the tap: the daemon refuses it.
	mustRefuse(t, g, tok, rohan, body+" — and ₹5,000 more", "different recipient or a different message")
	// Even trailing whitespace is a different message.
	mustRefuse(t, g, tok, rohan, body+" ", "different recipient or a different message")
	mustAdmit(t, g, tok, rohan, body)
}

func TestBindingDigestCannotBeReCutAcrossFields(t *testing.T) {
	if BindingDigest("ab", "cd") == BindingDigest("abc", "d") {
		t.Fatal("the binding digest must not be ambiguous across its fields")
	}
}

func TestParseTokenRejectsMalformed(t *testing.T) {
	bad := []string{
		"",
		"st1~whatsapp.send~short~1~-~" + strings.Repeat("a", 64),
		"st2~whatsapp.send~" + strings.Repeat("a", 32) + "~1~-~" + strings.Repeat("a", 64),
		"st1~whatsapp.send~" + strings.Repeat("a", 32) + "~notanumber~-~" + strings.Repeat("a", 64),
		"st1~whatsapp.send~" + strings.Repeat("a", 32) + "~1~-~nothex",
		"st1~~" + strings.Repeat("a", 32) + "~1~-~" + strings.Repeat("a", 64),
	}
	for _, s := range bad {
		if _, ok := parseToken(s); ok {
			t.Fatalf("parseToken accepted %q", s)
		}
	}
}
