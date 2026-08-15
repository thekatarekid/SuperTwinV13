package wa

import (
	"context"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// canonicalizer normalizes WhatsApp JIDs to a single stable form so the SAME
// conversation/person yields the SAME key across live vs history-sync vs
// reruns (contract §R2.4, bug 7). Two things vary across those sources and
// break dedupe:
//
//  1. Device/agent suffix. A live message's Chat/Sender may carry an agent and
//     device (e.g. "5511…:12@s.whatsapp.net"); history-sync gives the bare
//     JID. JID.ToNonAD() strips both.
//
//  2. LID (@lid) vs phone-number (@s.whatsapp.net) addressing. Modern
//     whatsmeow mixes these: the same person can appear as "…@lid" in one
//     message and "…@s.whatsapp.net" in another. We pick the PHONE-NUMBER JID
//     as canonical and resolve LID -> PN.
//
// resolveLIDToPN is a lookup (client.Store.LIDs.GetPNForLID / a per-message
// SenderAlt hint) that returns a PN JID and ok=false when no mapping is known.
// It is injected so the canonicalizer is unit-testable without a live client.
type canonicalizer struct {
	// selfPN is the user's own phone-number JID (client.Store.ID), non-AD.
	selfPN types.JID
	// selfLID is the user's own LID (client.Store.LID), non-AD. Messages in the
	// self chat may be addressed by either; both must collapse to selfPN.
	selfLID types.JID
	// resolveLIDToPN maps a LID JID to its PN JID. ok=false when unknown.
	resolveLIDToPN func(lid types.JID) (types.JID, bool)
}

// canonicalJID returns the canonical, device-stripped, LID->PN-normalized JID
// for j. Rules, in order:
//
//   - Empty in, empty out.
//   - Strip device/agent (ToNonAD).
//   - Groups/broadcasts/newsletters keep their own server; only device is
//     stripped (a group JID is already canonical).
//   - If the JID is us (self PN or self LID), return self PN.
//   - If the JID is a LID, resolve to PN when possible; otherwise keep the
//     normalized LID so it is at least stable across runs.
//   - PN JIDs are returned as-is (already canonical).
func (c *canonicalizer) canonicalJID(j types.JID) types.JID {
	if j.IsEmpty() {
		return j
	}
	j = j.ToNonAD()

	switch j.Server {
	case types.GroupServer, types.BroadcastServer, types.NewsletterServer:
		// Group-like JIDs are their own canonical identity; nothing to map.
		return j
	}

	// Collapse the self chat to our own PN regardless of how it's addressed.
	if !c.selfPN.IsEmpty() && sameUser(j, c.selfPN) {
		return c.selfPN
	}
	if !c.selfLID.IsEmpty() && sameUser(j, c.selfLID) {
		return c.selfPN
	}

	if j.Server == types.HiddenUserServer {
		if c.resolveLIDToPN != nil {
			if pn, ok := c.resolveLIDToPN(j); ok && !pn.IsEmpty() {
				return pn.ToNonAD()
			}
		}
		// PN unavailable: keep the normalized LID (stable across runs).
		return j
	}

	// Already a PN (or other user server): canonical as-is.
	return j
}

// canonicalString is canonicalJID rendered to the string form used on the wire.
func (c *canonicalizer) canonicalString(j types.JID) string {
	cj := c.canonicalJID(j)
	if cj.IsEmpty() {
		return ""
	}
	return cj.String()
}

// sameUser reports whether two JIDs refer to the same user+server after
// stripping device/agent. Used for self-chat detection.
func sameUser(a, b types.JID) bool {
	return a.User == b.User && a.Server == b.Server
}

// newCanonicalizer builds a canonicalizer bound to the engine's client. It
// resolves LID->PN via two sources, cheapest first:
//   - the per-message alt hint (SenderAlt/RecipientAlt carried on the event),
//     applied by the caller before falling back here;
//   - the persistent LID store (client.Store.LIDs.GetPNForLID).
func (e *Engine) newCanonicalizer() *canonicalizer {
	c := &canonicalizer{}
	if e.client != nil && e.client.Store != nil {
		if e.client.Store.ID != nil {
			c.selfPN = e.client.Store.ID.ToNonAD()
		}
		c.selfLID = e.client.Store.LID.ToNonAD()
		c.resolveLIDToPN = e.lidToPN
	}
	return c
}

// lidToPN resolves a LID JID to its phone-number JID via whatsmeow's LID store.
// Returns ok=false when no mapping exists (GetPNForLID returns EmptyJID,nil in
// that case) or on error. This is the version-specific API of whatsmeow
// v0.0.0-20260622185415: store.LIDStore.GetPNForLID(ctx, lid) (JID, error).
func (e *Engine) lidToPN(lid types.JID) (types.JID, bool) {
	if e.client == nil || e.client.Store == nil || e.client.Store.LIDs == nil {
		return types.EmptyJID, false
	}
	if lid.Server != types.HiddenUserServer {
		return types.EmptyJID, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pn, err := e.client.Store.LIDs.GetPNForLID(ctx, lid.ToNonAD())
	if err != nil || pn.IsEmpty() {
		return types.EmptyJID, false
	}
	return pn, true
}
