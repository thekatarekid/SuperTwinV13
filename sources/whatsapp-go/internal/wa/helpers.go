package wa

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/types"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// chatKind returns "group" for group/broadcast JIDs, else "dm".
func chatKind(chat types.JID) string {
	switch chat.Server {
	case types.GroupServer, types.BroadcastServer:
		return "group"
	default:
		return "dm"
	}
}

// skipChatJID reports whether a chat JID is noise we must never ingest
// (contract §R4.3, bug 17):
//   - status@broadcast : the Status/Stories feed (rendered as a "status" group).
//   - @newsletter      : WhatsApp Channels.
//   - @broadcast lists : broadcast-list JIDs (status@broadcast is one of these,
//     but ALL broadcast JIDs are skipped).
//
// Normal @g.us groups and @s.whatsapp.net / @lid DMs are KEPT.
func skipChatJID(chat types.JID) bool {
	switch chat.Server {
	case types.BroadcastServer, types.NewsletterServer:
		// Covers status@broadcast and every other broadcast/newsletter JID.
		return true
	}
	// Belt-and-suspenders: the literal status@broadcast user on any server.
	if chat.User == types.StatusBroadcastJID.User && chat.Server == types.StatusBroadcastJID.Server {
		return true
	}
	return false
}

// chatName resolves a human-friendly chat NAME for the channel.
//
//   - Groups: the group subject via GetGroupInfo (cached per group; refreshed
//     on GroupInfo events). Falls back to the group id only when genuinely
//     unknown (contract §R2.4, bug 4).
//   - DMs (including the self chat): the OTHER party's contact name. `chatPN`
//     is the canonical (LID->PN-resolved) peer JID so the contact-store lookup
//     works even when the message was LID-addressed. The live PushName is used
//     as a fallback when the store has nothing.
//
// Returns "" when no better-than-a-number name is known, so callers can decide
// whether to fall back to the number/JID.
func (e *Engine) chatName(info types.MessageInfo, chatPN types.JID) string {
	// History-sync name is authoritative for imported chats (contract §R6.1): it
	// is exactly what the phone shows, including unsaved businesses whose live
	// VerifiedName is empty on ParseWebMessage. Prefer it over everything else.
	if name := e.histChatName(chatPN); name != "" {
		return name
	}
	if chatKind(info.Chat) == "group" {
		return e.groupName(chatPN)
	}
	// DM (or self chat): name after the peer. A SAVED contact name is highest
	// priority — it's the name the user chose.
	if name := e.contactName(chatPN); name != "" {
		return name
	}
	// Business/enterprise senders (esp. unsaved OTP senders) carry their real name
	// in the message's VERIFIED-name field (contract §R5.2, bug 2). Prefer it over
	// the transient live PushName (bug: RC6) — a business's device PushName can be
	// a generic/handset label that would otherwise shadow the stable VerifiedName.
	// Only for incoming DMs (the peer is the business).
	if !info.IsFromMe {
		if vn := verifiedName(info); vn != "" {
			return vn
		}
	}
	// Fall back to the live push name of whoever sent this (for incoming DMs the
	// peer; skip for from_me where PushName is our own). Reject a masked/numeric
	// push name so it doesn't shadow the real number (contract §R7.3).
	if !info.IsFromMe && info.PushName != "" && !looksLikeNumberLabel(info.PushName) {
		return info.PushName
	}
	// History-sync pushname for the PEER. actorName already consults this; a DM
	// channel is named after its peer, so it must too — without this an unsaved
	// DM whose ONLY name source is HistorySync.Pushnames gets a named actor but
	// a nameless chat (the "message arrived, chat says Unknown" shape).
	if name := e.histPushName(chatPN); name != "" {
		return name
	}
	// LAST resort: WhatsApp's own system accounts (see officialAccountName).
	if name := officialAccountName(chatPN); name != "" {
		return name
	}
	return ""
}

// Legacy user server. Modern JIDs use types.DefaultUserServer ("s.whatsapp.net"),
// but history-synced rows can still carry the legacy "c.us" form.
const legacyUserServer = "c.us"

// officialAccountName is the LAST-RESORT label for WhatsApp's OWN accounts —
// the verified "WhatsApp" account that sends product announcements, and the
// official WhatsApp business number.
//
// These are the one case where no amount of lookup helps: WhatsApp ships no
// name for them through ANY channel we can read. They are never in the contact
// store (app-state never syncs them), carry no verified_name certificate (they
// are system accounts, not WABiz accounts), send no `notify` push name, and
// have an empty HistorySync Conversation.Name. USync cannot resolve the user
// part "0" either. WhatsApp's own clients render this label client-side, which
// is why whatsmeow exposes these only as JID constants.
//
// Matched on User/Server fields rather than the whatsmeow JID constants so this
// keeps compiling across whatsmeow bumps. Consulted AFTER every real data
// source, so any genuine name we ever learn still wins.
func officialAccountName(j types.JID) string {
	switch j.Server {
	case types.DefaultUserServer, legacyUserServer:
	default:
		return ""
	}
	switch j.ToNonAD().User {
	case "0": // PSA / official announcements account
		return "WhatsApp"
	case "16505361212": // official WhatsApp business account
		return "WhatsApp"
	}
	return ""
}

// verifiedName returns the business VERIFIED name carried on a message
// (contract §R5.2, bug 2), or "" when absent. whatsmeow exposes it on
// types.MessageInfo as *VerifiedName{Details *waVnameCert.VerifiedNameCertificate_Details};
// the human-readable name is Details.GetVerifiedName() (version
// v0.0.0-20260622185415). Certificate is the signed blob; Details is the parsed
// content whatsmeow already decoded for us.
func verifiedName(info types.MessageInfo) string {
	if info.VerifiedName == nil || info.VerifiedName.Details == nil {
		return ""
	}
	return info.VerifiedName.Details.GetVerifiedName()
}

// noteBusinessChat records that a canonical chat JID belongs to a WhatsApp
// Business / official account (v3-spec §5). Called from the three places that
// can PROVE it: a message carrying a verified-name certificate, a BusinessName
// event, and a USync lookup that resolved a verified name.
//
// On the FIRST proof it also re-emits the channel line, because the proof
// normally lands long after the chat was named — a saved business is named by
// the contact store on its very first message, and the certificate that follows
// improves nothing — so shouldEmitChannel's name-improvement gate would never let
// another line through and the worker's media gate would read a stale false
// forever. It re-emits under the name ALREADY emitted so the line can only ever
// add the flag, never walk a resolved name back.
func (e *Engine) noteBusinessChat(chatCanon types.JID) {
	id := jidString(chatCanon)
	if id == "" {
		return
	}
	e.mu.Lock()
	firstProof := !e.businessChats[id]
	e.businessChats[id] = true
	name, introduced := e.emittedChanName[id]
	e.mu.Unlock()
	if !firstProof || !introduced || e.isPaused() {
		return
	}
	_ = e.w.Channel(protocol.Channel{SourceExtID: id, Name: name, Kind: "dm", IsBusiness: true})
}

// businessChannel reports whether the channel for a canonical chat JID is a
// business or official account, and is read on EVERY channel emission so the
// flag survives the many name-driven re-emits. WhatsApp's own system accounts
// have no certificate to prove it with, so they are recognized by JID.
func (e *Engine) businessChannel(chatCanon types.JID) bool {
	if officialAccountName(chatCanon) != "" {
		return true
	}
	id := jidString(chatCanon)
	if id == "" {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.businessChats[id]
}

// actorName resolves a display NAME for the sender. `senderPN` is the canonical
// (LID->PN-resolved) sender JID so contact lookups hit by phone number.
// Returns "" when only a number/JID is known.
func (e *Engine) actorName(info types.MessageInfo, senderPN types.JID) string {
	if info.IsFromMe {
		// Our OWN messages: our push name, else "You" — never our number/mask
		// (contract §R7.3).
		return selfLabel(e.pushName())
	}
	// A SAVED contact name is highest priority — the name the user chose.
	if name := e.contactName(senderPN); name != "" {
		return name
	}
	// Verified business name from the message (contract §R5.2, bug 2): prefer it
	// over the transient live PushName (bug: RC6) so a business's stable
	// VerifiedName isn't shadowed by a generic device push name.
	if vn := verifiedName(info); vn != "" {
		return vn
	}
	// Reject a masked/numeric push name so it doesn't shadow the real number
	// (contract §R7.3); fall through to the history pushname / number instead.
	if info.PushName != "" && !looksLikeNumberLabel(info.PushName) {
		return info.PushName
	}
	// History-sync pushname (JID->pushname from HistorySync.Pushnames): names
	// actors in imported chats when the contact store & live PushName are empty
	// (contract §R6.1) — e.g. unsaved senders whose history was just imported.
	if name := e.histPushName(senderPN); name != "" {
		return name
	}
	// LAST resort: WhatsApp's own system accounts (see officialAccountName).
	if name := officialAccountName(senderPN); name != "" {
		return name
	}
	return ""
}

// selfLabel is the display name for the SELF chat / self actor when no better
// history-sync name is known: the user's own push name when it is a real name,
// else "You". Never our own phone number or a WhatsApp-masked value
// (contract §R7.3).
func selfLabel(pushName string) string {
	if pushName != "" && !looksLikeNumberLabel(pushName) {
		return pushName
	}
	return "You"
}

// contactName looks up a contact's stored name. It prefers FullName ->
// FirstName -> PushName -> BusinessName. Returns "" when nothing better than a
// number is known (the JID user part is NOT returned here; callers handle the
// fallback so we can distinguish "known name" from "just a number").
func (e *Engine) contactName(jid types.JID) string {
	if jid.IsEmpty() {
		return ""
	}
	// Test seam: a stubbed resolver replaces the live contact store.
	if e.contactNameFn != nil {
		return e.contactNameFn(jid.ToNonAD())
	}
	if e.client == nil || e.client.Store == nil || e.client.Store.Contacts == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// The contact store is keyed by phone-number JID; the caller passes the
	// canonical (LID->PN) JID, so look up that directly.
	c, err := e.client.Store.Contacts.GetContact(ctx, jid.ToNonAD())
	if err != nil {
		return ""
	}
	// Prefer the first REAL name. A WhatsApp privacy-masked value (e.g.
	// "+91••••••15") can appear in FullName/PushName for number-hidden contacts;
	// skip it so we fall back to the actual number/JID rather than storing rows
	// of stars as the name (contract §R7.3).
	for _, cand := range []string{c.FullName, c.FirstName, c.PushName, c.BusinessName} {
		if cand != "" && !isMaskedNumberLabel(cand) {
			return cand
		}
	}
	return ""
}

// contactNameForDM resolves a DM peer's contact name, adding an alias hop for a
// bare @lid key: when canonicalization left the JID as a LID (no PN mapping was
// known when the chat was introduced) but the LID store has since learned the PN,
// look the contact up under that PN too (bug: RC5 — modern businesses arrive
// @lid-first, so a saved contact keyed by PN is missed by a raw LID lookup). The
// direct contactName is tried first (covers PN keys and the rare LID-keyed
// contact); the PN alias is a fallback. Returns "" when neither hits.
func (e *Engine) contactNameForDM(c *canonicalizer, j types.JID) string {
	if name := e.contactName(j); name != "" {
		return name
	}
	if j.Server == types.HiddenUserServer && c != nil && c.resolveLIDToPN != nil {
		if pn, ok := c.resolveLIDToPN(j); ok && !pn.IsEmpty() {
			return e.contactName(pn)
		}
	}
	if name := e.histChatName(j); name != "" {
		return name
	}
	// Also stops the official account from being an eternally-nameless USync
	// candidate: it can never be resolved, so without this it is re-queried on
	// every sweep and keeps introducedNamelessDMs() above zero forever, holding
	// the periodic business-name resweep alive on every connect.
	if name := officialAccountName(j); name != "" {
		return name
	}
	return ""
}

// groupName returns a group's subject, fetching it via GetGroupInfo on first
// use and caching it. On failure it returns "" (callers fall back to the id).
func (e *Engine) groupName(groupJID types.JID) string {
	key := groupJID.String()
	e.mu.Lock()
	cached, ok := e.groupNames[key]
	e.mu.Unlock()
	if ok {
		return cached
	}
	name := e.fetchGroupSubject(groupJID)
	e.mu.Lock()
	e.groupNames[key] = name // cache even "" to avoid repeated lookups this run
	e.mu.Unlock()
	return name
}

// fetchGroupSubject calls whatsmeow's GetGroupInfo (READ-ONLY: an info query,
// not a message) and returns GroupInfo.GroupName.Name. Empty on error.
// Version-specific API of whatsmeow v0.0.0-20260622185415:
// (*Client).GetGroupInfo(ctx, jid) (*types.GroupInfo, error); the subject lives
// in the embedded types.GroupName.Name.
func (e *Engine) fetchGroupSubject(groupJID types.JID) string {
	if e.client == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	gi, err := e.client.GetGroupInfo(ctx, groupJID)
	if err != nil {
		e.logf("group info lookup failed for %s: %v", groupJID.String(), err)
		return ""
	}
	if gi == nil {
		return ""
	}
	return gi.Name
}

// setGroupName updates the group-subject cache (used by GroupInfo events).
func (e *Engine) setGroupName(groupJID types.JID, name string) {
	e.mu.Lock()
	e.groupNames[groupJID.String()] = name
	e.mu.Unlock()
}

// setHistChatName records the history-sync conversation name for a canonical
// chat JID (contract §R6.1). Only a non-empty, non-numeric name is stored so a
// bare-number "name" never shadows a real name learned elsewhere.
func (e *Engine) setHistChatName(chatCanon types.JID, name string) {
	if name == "" || looksLikeNumberLabel(name) {
		return
	}
	e.mu.Lock()
	e.histNames[chatCanon.String()] = name
	e.mu.Unlock()
}

// histChatName returns the history-sync conversation name for a canonical chat
// JID, or "" when none was recorded.
func (e *Engine) histChatName(chatCanon types.JID) string {
	if chatCanon.IsEmpty() {
		return ""
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.histNames[chatCanon.String()]
}

// setHistPushName records a HistorySync pushname for a canonical user JID
// (contract §R6.1). Numeric/empty pushnames are ignored.
func (e *Engine) setHistPushName(userCanon types.JID, name string) {
	if name == "" || looksLikeNumberLabel(name) {
		return
	}
	e.mu.Lock()
	e.histPushNames[userCanon.String()] = name
	e.mu.Unlock()
}

// histPushName returns the HistorySync pushname for a canonical user JID, or "".
func (e *Engine) histPushName(userCanon types.JID) string {
	if userCanon.IsEmpty() {
		return ""
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.histPushNames[userCanon.String()]
}

// trackAnchor records the oldest MessageInfo seen per chat, used as the anchor
// for on-demand older-history requests during Extend. Keyed by the CANONICAL
// chat JID so live and history-sync anchors for the same chat coincide.
func (e *Engine) trackAnchor(info types.MessageInfo, canonicalChat string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	cur, ok := e.oldestPerChat[canonicalChat]
	if !ok || info.Timestamp.Before(cur.Timestamp) {
		e.oldestPerChat[canonicalChat] = info
	}
}

// handleFromJID renders a phone-number handle from a JID (e.g. +15551234567).
// It only prefixes "+" for phone-number (PN) JIDs; a LID user part is NOT a
// phone number, so it is returned bare (never mislabeled as +<lid>).
func handleFromJID(jid types.JID) string {
	nad := jid.ToNonAD()
	u := nad.User
	if u == "" {
		return ""
	}
	// Only s.whatsapp.net user parts are phone numbers.
	if nad.Server == types.DefaultUserServer && isNumeric(u) {
		return "+" + u
	}
	return u
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// extFor maps a mime type to a file extension, falling back to def. The
// extension is what tells the media reader whether a document is readable at
// all (rich-media-spec §8), so parameters are stripped first — WhatsApp sends
// audio as "audio/ogg; codecs=opus".
func extFor(mime, def string) string {
	mime = strings.ToLower(strings.TrimSpace(mime))
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	switch mime {
	case "image/jpeg":
		return "jpg"
	case "image/png":
		return "png"
	case "image/gif":
		return "gif"
	case "image/webp":
		return "webp"
	case "video/mp4":
		return "mp4"
	case "video/3gpp":
		return "3gp"
	case "audio/ogg":
		return "ogg"
	case "audio/mpeg":
		return "mp3"
	case "audio/mp4", "audio/aac":
		return "m4a"
	case "application/pdf":
		return "pdf"
	// The readable document types (rich-media-spec §8) whose subtype is not
	// already a usable extension: "text/plain" would otherwise land as ".plain".
	case "text/plain":
		return "txt"
	case "text/markdown", "text/x-markdown":
		return "md"
	default:
		if i := strings.IndexByte(mime, '/'); i >= 0 && i+1 < len(mime) {
			sub := mime[i+1:]
			if isSimpleExt(sub) {
				return sub
			}
		}
		return def
	}
}

func isSimpleExt(s string) bool {
	if s == "" || len(s) > 5 {
		return false
	}
	for _, r := range s {
		if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

// extFromName extracts an extension from a filename, falling back to def. A
// trailing-dot name ("report.") has no extension either, so it takes def too
// rather than yielding an empty one.
func extFromName(name, def string) string {
	e := strings.TrimPrefix(filepath.Ext(name), ".")
	if e == "" {
		return def
	}
	return e
}

// safePathSegment renders s as ONE filesystem path segment. Both halves of a
// media path — the chat JID and the WhatsApp message id — arrive verbatim off
// the wire (whatsmeow assigns MessageInfo.ID straight from the stanza's `id`
// attribute), so a peer that sends media with an id of "../../../../x" would
// otherwise have the daemon write that file anywhere on disk. Anything outside
// the character set real JIDs and stanza ids use becomes "_", and a segment that
// is only dots (".", "..") is replaced outright, so the result can never climb
// out of mediaDir. Ordinary ids and JIDs pass through unchanged, so this does
// not move already-downloaded media.
func safePathSegment(s string) string {
	clean := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '.', r == '-', r == '_', r == '@', r == '+', r == ':':
			return r
		}
		return '_'
	}, s)
	if strings.Trim(clean, ".") == "" {
		return "_"
	}
	return clean
}

// --- tiny fs/crypto wrappers so events.go stays focused ---

func filepathJoin(parts ...string) string { return filepath.Join(parts...) }
func filepathBase(path string) string     { return filepath.Base(path) }
func mkdirAll(dir string) error           { return os.MkdirAll(dir, 0o755) }
func writeFile(path string, b []byte) error {
	return os.WriteFile(path, b, 0o644)
}
func sha256Sum(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
