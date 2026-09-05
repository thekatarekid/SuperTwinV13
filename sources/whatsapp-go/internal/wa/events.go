package wa

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"
	"time"
	"unicode"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/rangefilter"
)

// handleEvent is the single whatsmeow event handler. It maps connection state,
// live messages, history-sync batches, receipts (reactions), and logout to the
// NDJSON protocol.
//
// DEFENSE IN DEPTH: a top-level recover() guards the entire dispatch so a single
// malformed event (nil-map write, nil-deref, bad proto) can NEVER crash the
// handler or — critically — drop an entire HistorySync (all its
// conversations/messages) the way the "assignment to entry in nil map" panic did.
// whatsmeow already recovers panics in its own dispatcher, but that recovery is
// silent to OUR log and still aborts the whole event. Recovering HERE, logging
// the panic + stack to the daemon log (which the app captures into
// supertwin.log), and returning keeps the daemon alive and makes the failure
// visible instead of invisible. We deliberately do NOT swallow silently.
func (e *Engine) handleEvent(evt any) {
	defer func() {
		if r := recover(); r != nil {
			e.logf("PANIC recovered in handleEvent for %T: %v\n%s", evt, r, debug.Stack())
		}
	}()
	switch v := evt.(type) {
	case *events.Connected:
		e.mu.Lock()
		e.connectedAt = time.Now()
		e.mu.Unlock()
		_ = e.w.Status(protocol.StateOnline, "connected", e.selfJID(), e.pushName())
		// AppStateSyncComplete/OfflineSyncCompleted are the ONLY other refresh
		// triggers, and they frequently never fire — an already-synced connect and
		// every reconnect skip them (bug: RC4). Without a refresh here, verified-name
		// recovery never runs for those sessions and unsaved businesses stay pinned
		// to their number. Fire a short-delayed sweep after connect so the contact
		// store / LID map has settled; refreshInProgress guards against overlap with
		// the sync-complete triggers (contract §R3, bug 4).
		//
		// The connect+5s one-shot is NOT enough on a fresh re-sync: at connect+5s
		// history is still streaming, so the sweep runs against a near-empty candidate
		// set and GetUserInfo is never called (bug: RC7). onHistorySync re-arms the
		// sweep as batches land, and startBusinessNameResweep keeps re-running on a
		// bounded backoff until no introduced DM is left nameless.
		go e.scheduleRefreshKnownNames("connect+5s")
	case *events.Disconnected:
		if !e.isPaused() {
			_ = e.w.Status(protocol.StateReconnecting, "disconnected", "", "")
		}
	case *events.LoggedOut:
		_ = e.w.Status(protocol.StateLoggedOut, fmt.Sprintf("logged out: %v", v.Reason), "", "")
	case *events.Message:
		e.onMessage(v)
	case *events.HistorySync:
		e.onHistorySync(v)
	case *events.PushName:
		// A push name arrived/changed for a user: re-emit the actor (and, for a
		// DM, the channel) so the worker upgrades the stored name (bug 4).
		e.onNameUpdate(v.JID, v.JIDAlt, v.NewPushName)
	case *events.Contact:
		// Contact-list name changed on another device.
		name := ""
		if v.Action != nil {
			if fn := v.Action.GetFullName(); fn != "" {
				name = fn
			} else if fn := v.Action.GetFirstName(); fn != "" {
				name = fn
			}
		}
		e.onNameUpdate(v.JID, types.EmptyJID, name)
	case *events.BusinessName:
		// Only a WABiz account has a business name at all, so the event itself
		// classifies the chat (v3-spec §5).
		e.noteBusinessChat(e.newCanonicalizer().canonicalJID(v.JID))
		e.onNameUpdate(v.JID, types.EmptyJID, v.NewBusinessName)
	case *events.GroupInfo:
		// Group subject changed: refresh cache and re-emit the channel (bug 4).
		if v.Name != nil {
			e.onGroupNameUpdate(v.JID, v.Name.Name)
		}
	case *events.AppStateSyncComplete:
		// whatsmeow mass-inserts the contact list via PutAllContactNames on the
		// initial full app-state sync WITHOUT firing per-contact events, so a chat
		// imported before its contact synced keeps its import-time number/mask.
		// This signal fires once the contact patch is applied; sweep and re-resolve
		// names for chats we already introduced (contract §R2.4, bug 4 / R7.3).
		if v.Name == appstate.WAPatchCriticalUnblockLow {
			go e.refreshKnownNames("app-state-sync")
		}
	case *events.OfflineSyncCompleted:
		// Belt-and-suspenders: history-sync push names also land event-lessly.
		go e.refreshKnownNames("offline-sync")
	default:
		// Ignore other events (presence, receipts we don't surface, etc.).
	}
}

// onNameUpdate re-emits an actor (and DM channel) when a better name is learned
// for a user AFTER its first event (contract §R2.4, bug 4). Only fires if the
// identity has already been emitted this run and the new name is an
// improvement; emitWithMeta's shouldEmit* gate the actual write.
func (e *Engine) onNameUpdate(jid, jidAlt types.JID, learnedName string) {
	if e.isPaused() {
		return
	}
	c := e.newCanonicalizer()
	canon := e.canonicalUserJID(c, jid, jidAlt)
	id := jidString(canon)
	if id == "" {
		return
	}
	// Only bother if we've already introduced this actor/channel (otherwise the
	// next message will carry the name anyway).
	e.mu.Lock()
	_, actSeen := e.emittedActs[id]
	_, chanSeen := e.emittedChans[id]
	isSelf := !c.selfPN.IsEmpty() && id == c.selfPN.String()
	e.mu.Unlock()

	// Prefer the freshly learned name; else re-resolve from the contact store.
	name := learnedName
	if name == "" {
		name = e.contactName(canon)
	}
	if name == "" {
		return
	}

	if actSeen {
		if e.shouldEmitActor(id, name) {
			_ = e.w.Actor(protocol.Actor{
				SourceExtID: id,
				DisplayName: name,
				Handle:      handleFromJID(canon),
				IsSelf:      isSelf,
			})
		}
	}
	// For a DM, the channel is named after the peer, so update it too.
	if chanSeen && canon.Server != types.GroupServer && canon.Server != types.BroadcastServer {
		if e.shouldEmitChannel(id, name) {
			_ = e.w.Channel(protocol.Channel{
				SourceExtID: id,
				Name:        name,
				Kind:        "dm",
				IsBusiness:  e.businessChannel(canon),
			})
		}
	}
}

// onGroupNameUpdate refreshes the cached group subject and re-emits the channel
// with the new name if that group has already been introduced (bug 4).
func (e *Engine) onGroupNameUpdate(groupJID types.JID, name string) {
	if e.isPaused() || name == "" {
		return
	}
	c := e.newCanonicalizer()
	canon := c.canonicalJID(groupJID)
	e.setGroupName(canon, name)
	id := jidString(canon)
	e.mu.Lock()
	_, seen := e.emittedChans[id]
	e.mu.Unlock()
	if !seen {
		return
	}
	if e.shouldEmitChannel(id, name) {
		_ = e.w.Channel(protocol.Channel{
			SourceExtID: id,
			Name:        name,
			Kind:        "group",
		})
	}
}

func (e *Engine) pushName() string {
	if e.client != nil {
		return e.client.Store.PushName
	}
	return ""
}

// refreshDelay is how long scheduleRefreshKnownNames waits after a connect before
// sweeping names, giving whatsmeow's post-connect contact/app-state/LID inserts a
// moment to land so the sweep resolves against a populated store.
const refreshDelay = 5 * time.Second

// scheduleRefreshKnownNames runs refreshKnownNames after a short delay. It is the
// connect/reconnect trigger (bug: RC4) — the sync-complete events that also drive
// the sweep frequently never fire on an already-synced or reconnecting session.
// The delay lets post-connect contact/LID inserts settle first; refreshInProgress
// (inside refreshKnownNames) collapses overlapping triggers to a single sweep.
// trigger is a short label recorded in the diagnostic log so a no-op sweep is
// attributable to the event that armed it.
func (e *Engine) scheduleRefreshKnownNames(trigger string) {
	if e.isPaused() {
		return
	}
	select {
	case <-e.ctx.Done():
		return
	case <-time.After(refreshDelay):
	}
	e.refreshKnownNames(trigger)
}

// refreshKnownNames re-resolves and re-emits names for every chat/actor the
// daemon has already introduced this run, once the contact store has been
// (bulk-)populated by app-state sync. whatsmeow mass-inserts contacts via
// PutAllContactNames WITHOUT firing per-contact events, and history push-names
// land event-lessly too, so a chat imported before its contact synced never gets
// an onNameUpdate — it keeps its import-time number/mask, which the UI then
// renders as "Unknown". shouldEmit*/nameIsBetter make every re-emit idempotent
// (only real-name upgrades pass; no churn). READ-ONLY: GetContact/GetGroupInfo
// are local/at-most-cached reads.
//
// refreshInProgress collapses overlapping triggers (connect + app-state-sync +
// offline-sync, or a reconnect landing mid-sweep) into a single in-flight sweep so
// they don't fire duplicate USync verified-name lookups (contract §R3).
func (e *Engine) refreshKnownNames(trigger string) {
	// Production always has a client by the time any refresh trigger fires. A nil
	// client with no test seam means there is nothing to resolve against, so bail;
	// tests inject userInfoFn/contactNameFn and drive the sweep without a live client.
	if e.isPaused() || (e.client == nil && e.userInfoFn == nil && e.contactNameFn == nil) {
		return
	}
	// Single-flight: if a sweep is already running, skip. The running sweep already
	// snapshots the latest introduced set, so a concurrent trigger adds nothing.
	e.mu.Lock()
	if e.refreshInProgress {
		e.mu.Unlock()
		e.logf("refreshKnownNames[%s]: skipped (sweep already in progress)", trigger)
		return
	}
	e.refreshInProgress = true
	sinceConnect := time.Duration(-1)
	if !e.connectedAt.IsZero() {
		sinceConnect = time.Since(e.connectedAt)
	}
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		e.refreshInProgress = false
		e.mu.Unlock()
	}()

	c := e.newCanonicalizer()

	// Snapshot the ids we've introduced (don't hold e.mu during emits/lookups). The
	// DM candidate set is the UNION of oldestPerChat (chats that carried a mapped
	// message) and emittedChans (channels introduced without a mapped message, e.g.
	// a channel line emitted ahead of its first event), so a DM is a candidate even
	// when no message flowed through mapMessage for it (bug: RC7 STEP 4).
	e.mu.Lock()
	chatSet := make(map[string]struct{}, len(e.oldestPerChat)+len(e.emittedChans))
	for k := range e.oldestPerChat {
		chatSet[k] = struct{}{}
	}
	for k := range e.emittedChans {
		chatSet[k] = struct{}{}
	}
	chatKeys := make([]string, 0, len(chatSet))
	for k := range chatSet {
		chatKeys = append(chatKeys, k)
	}
	actKeys := make([]string, 0, len(e.emittedActs))
	for k := range e.emittedActs {
		actKeys = append(actKeys, k)
	}
	e.mu.Unlock()

	e.logf("refreshKnownNames[%s]: entry (%.1fs since connect) chats=%d actors=%d",
		trigger, sinceConnect.Seconds(), len(chatKeys), len(actKeys))

	var namelessDMs []types.JID

	// Channels: DMs get the peer's contact name; groups keep their subject.
	for _, key := range chatKeys {
		j, err := types.ParseJID(key)
		if err != nil || j.IsEmpty() {
			continue
		}
		if j.Server == types.GroupServer || j.Server == types.BroadcastServer {
			if name := e.groupName(j); name != "" && e.shouldEmitChannel(key, name) {
				_ = e.w.Channel(protocol.Channel{SourceExtID: key, Name: name, Kind: "group"})
			}
			continue
		}
		// Only real DM servers are candidates for a USync verified-name lookup; skip
		// anything that isn't a phone-number or LID DM (STEP 4).
		if j.Server != types.DefaultUserServer && j.Server != types.HiddenUserServer {
			continue
		}
		// contactNameForDM also tries a now-known PN alias for a bare @lid key, so a
		// LID-addressed saved contact whose LID->PN mapping only landed AFTER the
		// chat was introduced still resolves (bug: RC5).
		name := e.contactNameForDM(c, j)
		if name == "" {
			namelessDMs = append(namelessDMs, j)
			continue
		}
		if e.shouldEmitChannel(key, name) {
			_ = e.w.Channel(protocol.Channel{SourceExtID: key, Name: name, Kind: "dm", IsBusiness: e.businessChannel(j)})
		}
	}

	e.logf("refreshKnownNames[%s]: namelessDMs=%d", trigger, len(namelessDMs))

	// Actors: re-resolve from the contact store (self excluded — its label is
	// pushName-based and already correct).
	for _, key := range actKeys {
		j, err := types.ParseJID(key)
		if err != nil || j.IsEmpty() {
			continue
		}
		if !c.selfPN.IsEmpty() && key == c.selfPN.String() {
			continue
		}
		if name := e.contactNameForDM(c, j); name != "" && e.shouldEmitActor(key, name) {
			_ = e.w.Actor(protocol.Actor{
				SourceExtID: key,
				DisplayName: name,
				Handle:      handleFromJID(j),
				IsSelf:      false,
			})
		}
	}

	// Recover verified business names for DMs that still have no name (unsaved
	// businesses like Jio/OTP senders) via ONE bounded, read-only USync lookup.
	e.resolveUnsavedBusinessNames(trigger, namelessDMs)

	// If any introduced DM is still nameless after this sweep, arm the bounded
	// periodic re-sweep (STEP 3). On a fresh re-sync the first sweep runs while
	// history is still streaming, so the candidate set fills in later; the resweep
	// keeps trying on a backoff until every introduced DM has a name (or the cap /
	// ctx cancel stops it). startBusinessNameResweep single-flights itself.
	if len(namelessDMs) > 0 {
		e.startBusinessNameResweep()
	}
}

const (
	// businessNameBatchSize is how many name-less DM JIDs one USync GetUserInfo
	// call resolves. USync is the API WhatsApp flags for enumeration abuse, so we
	// keep each call modest and only ever query JIDs we already converse with.
	businessNameBatchSize = 128
	// maxBusinessNameBatches caps how many batches one sweep drains, so a pile of
	// nameless chats can't fan out into an unbounded run of USync calls in a single
	// sweep. The full backlog still drains across sweeps (a later sweep retries any
	// leftover), while a single sweep stays bounded.
	maxBusinessNameBatches = 8
	// businessNameLookupTimeout bounds each USync GetUserInfo call.
	businessNameLookupTimeout = 20 * time.Second
)

// resolveUnsavedBusinessNames recovers verified business names for DMs that still
// resolved to a bare number/LID (unsaved Jio/OTP senders whose live VerifiedName
// never arrived and whose history ParseWebMessage carried none) via READ-ONLY
// USync GetUserInfo. GetUserInfo is a USync info query, NOT a chat send, so the
// read-only invariant holds; it also accepts @lid JIDs directly, so a business
// that only ever arrived @lid-first is queryable without a PN mapping (bug: RC3/
// RC5).
//
// Reliability (bug: RC3):
//   - The full nameless set is drained in bounded BATCHES (not hard-truncated to
//     one 128-cap call that silently drops the rest).
//   - businessNameQueried is recorded ONLY for a JID whose lookup returned a real
//     verified name — a timeout or empty/absent result is left un-recorded so a
//     LATER sweep RETRIES it. This makes recovery robust to the 20s timeout and to
//     businesses whose profile is fetched lazily server-side.
func (e *Engine) resolveUnsavedBusinessNames(trigger string, nameless []types.JID) {
	lookup := e.userInfoFn
	if lookup == nil {
		if e.client == nil {
			return
		}
		lookup = e.client.GetUserInfo
	}
	if len(nameless) == 0 {
		// A no-op sweep must log itself as a no-op so it is distinguishable from a
		// sweep that never fired at all (bug: RC7 — a silent len==0 early-return hid
		// that the candidate set was empty while history was still streaming).
		e.logf("resolveUnsavedBusinessNames[%s]: no-op (nameless=0)", trigger)
		return
	}

	// Only query JIDs not already SUCCESSFULLY resolved this process. We do NOT
	// mark them queried here — marking happens on success only (below), so a failed
	// lookup is retried on the next sweep.
	e.mu.Lock()
	todo := make([]types.JID, 0, len(nameless))
	seen := map[string]bool{}
	for _, j := range nameless {
		key := j.String()
		if e.businessNameQueried[key] || seen[key] {
			continue
		}
		seen[key] = true
		todo = append(todo, j)
	}
	e.mu.Unlock()
	e.logf("resolveUnsavedBusinessNames[%s]: nameless=%d todo=%d", trigger, len(nameless), len(todo))
	if len(todo) == 0 {
		return
	}

	for batch := 0; batch < maxBusinessNameBatches && len(todo) > 0; batch++ {
		n := len(todo)
		if n > businessNameBatchSize {
			n = businessNameBatchSize
		}
		chunk := todo[:n]
		todo = todo[n:]
		e.logf("resolveUnsavedBusinessNames[%s]: batch %d chunk=%d", trigger, batch, len(chunk))
		e.resolveBusinessNameBatch(lookup, chunk)
	}
}

// resolveBusinessNameBatch runs ONE USync GetUserInfo lookup over chunk, then
// recovers each queried JID's name FROM THE CONTACT STORE — not from the returned
// UserInfo.VerifiedName (bug: RC-LOADBEARING). whatsmeow v0.0.0-20260622185415's
// GetUserInfo NEVER assigns UserInfo.VerifiedName: it calls updateBusinessName,
// which WRITES whatsmeow_contacts.business_name (and dispatches events.BusinessName)
// but leaves info.VerifiedName nil. So the name we asked for lands in the store as
// a side effect of the call, and e.contactName(jid) (which prefers BusinessName)
// reads it back — reading ui.VerifiedName would drop every JID even though the name
// was just persisted.
//
// businessNameQueried is recorded ONLY for a JID whose store re-read returned a real
// (letter-bearing, non-numeric) name, so an empty result stays retryable on a later
// sweep (bug: RC3). A lookup error leaves the whole chunk un-recorded and retryable.
func (e *Engine) resolveBusinessNameBatch(lookup func(context.Context, []types.JID) (map[types.JID]types.UserInfo, error), chunk []types.JID) {
	ctx, cancel := context.WithTimeout(context.Background(), businessNameLookupTimeout)
	defer cancel()
	if _, err := lookup(ctx, chunk); err != nil {
		// Un-recorded: a later sweep retries this chunk (bug: RC3 — no silent drop
		// on the 20s timeout).
		e.logf("business-name lookup failed (%d jids): %v", len(chunk), err)
		return
	}
	// The USync call above persisted any verified/business names into the contact
	// store. Re-read each QUERIED JID from the store (not the returned map) and emit
	// whatever real name is now there.
	for _, jid := range chunk {
		key := jid.ToNonAD().String()
		e.mu.Lock()
		already := e.businessNameQueried[key]
		e.mu.Unlock()
		if already {
			e.logf("resolveBusinessNameBatch: %s skipped (already queried)", key)
			continue
		}
		name := e.contactName(jid)
		if name == "" || looksLikeNumberLabel(name) {
			// Empty-after-store-read: leave un-recorded so a later sweep retries this
			// JID (the business profile may be fetched lazily server-side).
			e.logf("resolveBusinessNameBatch: %s empty-after-store-read (retryable)", key)
			continue
		}
		e.logf("resolveBusinessNameBatch: %s resolved to %q", key, name)
		// Record success so a later sweep doesn't re-query this resolved business.
		e.mu.Lock()
		e.businessNameQueried[key] = true
		e.mu.Unlock()
		// USync only ever hands back a VERIFIED business name, so a hit here is
		// itself proof the chat is a business (v3-spec §5).
		e.noteBusinessChat(jid.ToNonAD())
		if e.shouldEmitChannel(key, name) {
			_ = e.w.Channel(protocol.Channel{SourceExtID: key, Name: name, Kind: "dm", IsBusiness: true})
		}
		if e.shouldEmitActor(key, name) {
			_ = e.w.Actor(protocol.Actor{SourceExtID: key, DisplayName: name, Handle: handleFromJID(jid), IsSelf: false})
		}
	}
}

// resweepBackoff is the bounded schedule the periodic business-name re-sweep runs
// on: quick early retries (history is still landing) that stretch out, capped at a
// steady 60s cadence. The re-sweep stops when no introduced DM is left nameless, at
// the resweepCap, or on ctx cancel/pause — so it never leaks (STEP 3).
var resweepBackoff = []time.Duration{5 * time.Second, 15 * time.Second, 30 * time.Second}

const (
	// resweepSteady is the cadence the re-sweep settles into after the backoff ramp.
	resweepSteady = 60 * time.Second
	// resweepCap bounds the total wall-clock lifetime of one re-sweep goroutine so it
	// can never run forever against a business whose profile is permanently nameless.
	resweepCap = 5 * time.Minute
)

// startBusinessNameResweep launches (at most one) bounded goroutine that keeps
// re-running refreshKnownNames while any introduced DM is still nameless. It exists
// because the first sweep on a fresh re-sync fires while history is still streaming,
// so the candidate set (and the contact store the USync side-effect writes into)
// only fills in over the following seconds (bug: RC7). resweepActive single-flights
// it; refreshKnownNames's own refreshInProgress collapses any overlap with the
// event-driven triggers, and businessNameQueried ensures a resolved JID isn't
// re-queried.
func (e *Engine) startBusinessNameResweep() {
	e.mu.Lock()
	if e.resweepActive {
		e.mu.Unlock()
		return
	}
	e.resweepActive = true
	e.mu.Unlock()

	go func() {
		defer func() {
			e.mu.Lock()
			e.resweepActive = false
			e.mu.Unlock()
		}()
		deadline := time.Now().Add(resweepCap)
		for i := 0; ; i++ {
			var wait time.Duration
			if i < len(resweepBackoff) {
				wait = resweepBackoff[i]
			} else {
				wait = resweepSteady
			}
			timer := time.NewTimer(wait)
			select {
			case <-e.ctx.Done():
				timer.Stop()
				e.logf("business-name resweep: stopped (ctx done)")
				return
			case <-timer.C:
			}
			if e.isPaused() {
				e.logf("business-name resweep: stopped (paused)")
				return
			}
			if time.Now().After(deadline) {
				e.logf("business-name resweep: stopped (cap %s reached)", resweepCap)
				return
			}
			if e.introducedNamelessDMs() == 0 {
				e.logf("business-name resweep: stopped (no nameless DMs remain)")
				return
			}
			e.refreshKnownNames("resweep")
		}
	}()
}

// introducedNamelessDMs counts introduced DM chats that still resolve to no real
// name AND have not already been successfully queried this process. It is the
// stop-condition for the periodic re-sweep: once it hits zero there is nothing left
// to recover. READ-ONLY (contact-store reads only).
func (e *Engine) introducedNamelessDMs() int {
	c := e.newCanonicalizer()
	e.mu.Lock()
	keys := make(map[string]struct{}, len(e.oldestPerChat)+len(e.emittedChans))
	for k := range e.oldestPerChat {
		keys[k] = struct{}{}
	}
	for k := range e.emittedChans {
		keys[k] = struct{}{}
	}
	e.mu.Unlock()

	n := 0
	for key := range keys {
		j, err := types.ParseJID(key)
		if err != nil || j.IsEmpty() {
			continue
		}
		if j.Server != types.DefaultUserServer && j.Server != types.HiddenUserServer {
			continue // groups/broadcast/newsletter aren't business-name candidates
		}
		e.mu.Lock()
		queried := e.businessNameQueried[j.String()]
		e.mu.Unlock()
		if queried {
			continue
		}
		if e.contactNameForDM(c, j) == "" {
			n++
		}
	}
	return n
}

// onMessage handles a live message event.
func (e *Engine) onMessage(m *events.Message) {
	if e.isPaused() {
		return
	}
	// S1.5: no live ingest between pairing and confirm. Until Import/SetRange
	// installs the user's window, a live arrival is HELD (bounded), not emitted —
	// and not lost either: drainPendingLive releases it on confirm.
	if e.holdIfNoRange(m) {
		return
	}
	ev, chanMeta, actorMeta, ok := e.mapMessage(m.Info, m.Message)
	if !ok {
		return
	}
	e.emitWithMeta(chanMeta, actorMeta, ev)
}

// onHistorySync handles a batch of historical conversations, applying the
// active import range filter (contract §4). It also:
//   - records the conversation's own name (Conversation.Name/DisplayName) and
//     the batch's Pushnames so imported chats — including unsaved businesses —
//     take the name the phone shows (contract §R6.1);
//   - counts chats_total as the number of IN-RANGE chats (not the total chat
//     count the initial bootstrap delivers), so a 24h import reports e.g. 12/12
//     rather than 12/293, and fires done when the in-range set is imported
//     (contract §R6.3).
func (e *Engine) onHistorySync(hs *events.HistorySync) {
	if e.isPaused() || hs.Data == nil {
		return
	}
	// Buffer the automatic post-pairing HistorySync until an import range is
	// installed, so the user's onboarding selection (delivered via Import/SetRange
	// moments later) filters it — not a default window. ON_DEMAND batches are
	// extend/paginator responses for an already-installed range and are never
	// buffered.
	onDemand := hs.Data.GetSyncType() == waHistorySync.HistorySync_ON_DEMAND
	// Measure BEFORE the buffering decision so count_range can answer while the
	// batch is still held (S1.5 / T4-7): the connect flow counts, then confirms.
	e.recordHistoryStamps(hs)
	if !onDemand && e.bufferIfNoRange(hs) {
		return
	}
	e.processHistorySync(hs)
}

// maxPendingLive bounds the pairing→confirm live hold (S1.5). A confirm card left
// open for hours in a busy group must not grow memory without limit; on overflow
// the OLDEST held message is dropped (the worker's funnel would have dropped all
// of them before this hold existed).
const maxPendingLive = 2000

// holdIfNoRange holds a live message while no import window is confirmed and
// reports whether it did. Check and append happen under one lock so a concurrent
// SetRange cannot strand a message between them.
func (e *Engine) holdIfNoRange(m *events.Message) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.haveImport {
		return false
	}
	if len(e.pendingLive) >= maxPendingLive {
		e.pendingLive = e.pendingLive[1:]
		e.logf("live hold full (%d messages, no range confirmed yet); dropping the oldest", maxPendingLive)
	}
	e.pendingLive = append(e.pendingLive, m)
	return true
}

// drainPendingLive emits every live message held before the window was confirmed,
// in arrival order, through the normal live path. Callers install the range
// FIRST (Import/SetRange), so holdIfNoRange lets them through.
func (e *Engine) drainPendingLive() {
	e.mu.Lock()
	held := e.pendingLive
	e.pendingLive = nil
	e.mu.Unlock()
	if len(held) > 0 {
		e.logf("releasing %d live messages held until the window was confirmed", len(held))
	}
	for _, m := range held {
		e.onMessage(m)
	}
}

// recordHistoryStamps notes (chat, ts) for every message in a HistorySync payload
// plus its sync type, so CountRange can measure per-window counts over what
// WhatsApp actually sent — whether or not the batch is buffered, processed, or
// filtered out later. Noise chats (status/newsletter/broadcast) are skipped the
// way processHistorySync skips them; a message with no timestamp is skipped too.
func (e *Engine) recordHistoryStamps(hs *events.HistorySync) {
	if hs == nil || hs.Data == nil {
		return
	}
	c := e.newCanonicalizer()
	e.mu.Lock()
	defer e.mu.Unlock()
	e.histBatches++
	if e.histSyncTypes == nil {
		e.histSyncTypes = map[string]bool{}
	}
	if e.histStamps == nil {
		e.histStamps = map[string]rangefilter.Stamp{}
	}
	e.histSyncTypes[hs.Data.GetSyncType().String()] = true
	for _, conv := range hs.Data.GetConversations() {
		chatJID, err := types.ParseJID(conv.GetID())
		if err != nil || skipChatJID(chatJID) {
			continue
		}
		chat := jidString(c.canonicalJID(chatJID))
		for _, hm := range conv.GetMessages() {
			wm := hm.GetMessage()
			if wm == nil {
				continue
			}
			ts := wm.GetMessageTimestamp()
			if ts == 0 {
				continue
			}
			id := wm.GetKey().GetID()
			if id == "" {
				continue
			}
			e.histStamps[chat+"/"+id] = rangefilter.Stamp{Chat: chat, TS: time.Unix(int64(ts), 0)}
		}
	}
}

// CountRange answers `count_range` (S1.5, T4-7) with a `range_counts` frame:
// per-window chat/message counts MEASURED over every history message this
// process has seen, plus the caveats that make the number honest — which sync
// types arrived (bootstrap-only means the count will still rise), how far back
// the received history reaches, how much is still buffered, and how many live
// messages are held pending the confirm. Read-only: installs and drains nothing.
func (e *Engine) CountRange() {
	e.mu.Lock()
	stamps := make([]rangefilter.Stamp, 0, len(e.histStamps))
	for _, s := range e.histStamps {
		stamps = append(stamps, s)
	}
	syncTypes := make([]string, 0, len(e.histSyncTypes))
	for k := range e.histSyncTypes {
		syncTypes = append(syncTypes, k)
	}
	buffered := len(e.pendingHistory)
	batches := e.histBatches
	have := e.haveImport
	r := e.importRange
	pendingLive := len(e.pendingLive)
	e.mu.Unlock()
	sort.Strings(syncTypes)

	now := time.Now()
	counts := rangefilter.CountByRange(stamps, now)
	oldest, newest := rangefilter.Bounds(stamps)
	out := protocol.RangeCounts{
		Counts:          counts,
		Chats:           counts[protocol.RangeAll].Chats,
		Messages:        counts[protocol.RangeAll].Messages,
		BufferedBatches: buffered,
		Batches:         batches,
		SyncTypes:       syncTypes,
		RangeInstalled:  have,
		PendingLive:     pendingLive,
	}
	if have {
		out.Range = r
	}
	if !oldest.IsZero() {
		out.OldestTS = protocol.FormatTime(oldest)
		out.NewestTS = protocol.FormatTime(newest)
	}
	e.logf("count_range: %d messages in %d chats across %d payloads (%d buffered, %d live held, types %v)",
		out.Messages, out.Chats, batches, buffered, pendingLive, syncTypes)
	_ = e.w.RangeCounts(out)
}

// processHistorySync ingests one HistorySync batch filtered by the installed
// import range (contract §4). Called live once a range is set, or from
// drainPendingHistory for batches buffered before the user picked a range.
func (e *Engine) processHistorySync(hs *events.HistorySync) {
	if e.isPaused() || hs.Data == nil {
		return
	}
	// Reset the quiet-window timer: a history-sync batch just arrived, so the
	// "no new history for ~10-12s" completion clock restarts (contract §R7.2).
	// Only the automatic bootstrap/recent/full history refreshes the window —
	// ON_DEMAND responses (our own back-pagination) must NOT keep the import
	// banner open for minutes (see noteHistoryBatch).
	onDemand := hs.Data.GetSyncType() == waHistorySync.HistorySync_ON_DEMAND
	e.noteHistoryBatch(onDemand)

	e.mu.Lock()
	r := e.importRange
	have := e.haveImport
	e.mu.Unlock()
	r = effectivePushedRange(r, have)
	now := time.Now()

	// Consume the batch's Pushnames (JID->pushname) FIRST so actor names are
	// available while we map this batch's messages (contract §R6.1).
	e.absorbPushnames(hs)

	// Persist the batch's LID<->PN pairs into the local LID store BEFORE mapping so
	// this batch's LID-addressed messages canonicalize to their PN (bug: RC5 —
	// modern businesses arrive @lid-first; a saved contact keyed by PN is otherwise
	// missed). History sync carries these both batch-wide
	// (PhoneNumberToLidMappings) and per-conversation (LidJID <-> the PN thread id).
	e.absorbLIDMappings(hs)

	// Per-payload accounting. Diagnosing the shallow-import incident needed a
	// query against the live whatsmeow DB to establish how much history WhatsApp
	// had actually sent, because the log recorded only that batches arrived —
	// never their shape. These counters make "the server sent us almost nothing"
	// and "we filtered almost everything out" distinguishable from the log alone.
	// One line per PAYLOAD, never per message.
	var convsSeen, convsInRange, msgsSeen, msgsInRange, msgsUnparsed, msgsOutOfRange, msgsEmitted int

	// Record each in-range conversation's own name and pre-count the in-range set
	// so chats_total is the IN-RANGE total, not the full chat count (R6.3).
	c := e.newCanonicalizer()
	for _, conv := range hs.Data.GetConversations() {
		chatJID, err := types.ParseJID(conv.GetID())
		if err != nil || skipChatJID(chatJID) {
			continue
		}
		lastTS := conversationLastActivity(conv)
		if !lastTS.IsZero() && !rangefilter.ChatInRange(r, lastTS, now) {
			continue
		}
		chatCanon := c.canonicalJID(chatJID)
		if name := conversationName(conv); name != "" {
			e.setHistChatName(chatCanon, name)
		}
		e.backfill.mu.Lock()
		if e.backfill.inRange == nil {
			e.backfill.inRange = map[string]bool{}
		}
		e.backfill.inRange[jidString(chatCanon)] = true
		e.backfill.chatsTotal = len(e.backfill.inRange)
		e.backfill.mu.Unlock()
	}

	for _, conv := range hs.Data.GetConversations() {
		convsSeen++
		chatJID, err := types.ParseJID(conv.GetID())
		if err != nil {
			continue
		}
		// Filter noise chats (status@broadcast/newsletter/broadcast) before we
		// count them toward totals (contract §R4.3, bug 17).
		if skipChatJID(chatJID) {
			continue
		}
		// Filter 1: chat active within range (use newest message ts).
		lastTS := conversationLastActivity(conv)
		if !lastTS.IsZero() && !rangefilter.ChatInRange(r, lastTS, now) {
			continue
		}
		convsInRange++

		// History sync hands a conversation back NEWEST-FIRST — verified on the live
		// DB. Emitting it in that order puts every backward reference on the stream
		// ahead of the message it points at, so an edit, a revoke or a reaction
		// reaches the worker with nothing yet to fold into. Replay each conversation
		// in the order it was actually written instead.
		msgs := append([]*waHistorySync.HistorySyncMsg(nil), conv.GetMessages()...)
		sort.SliceStable(msgs, func(i, j int) bool {
			return msgs[i].GetMessage().GetMessageTimestamp() < msgs[j].GetMessage().GetMessageTimestamp()
		})

		for _, histMsg := range msgs {
			msgsSeen++
			webMsg := histMsg.GetMessage()
			if webMsg == nil {
				msgsUnparsed++
				continue
			}
			parsed, err := e.parseWebMessage(chatJID, webMsg)
			if err != nil {
				msgsUnparsed++
				continue
			}
			// Filter 2: message within range.
			if !rangefilter.MessageInRange(r, parsed.Info.Timestamp, now) {
				msgsOutOfRange++
				continue
			}
			// Counted separately from msgsEmitted: a message can clear the range
			// filter and still fail to map, and the gap between the two is the only
			// signal that tells "the server sent little" apart from "we dropped it".
			msgsInRange++
			ev, chanMeta, actorMeta, ok := e.mapMessage(parsed.Info, parsed.Message)
			if !ok {
				msgsUnparsed++
				continue
			}
			msgsEmitted++
			// onEvent is the worker's single entry point for BOTH sources and nothing
			// on the wire tells them apart, so an import arrived looking like live
			// traffic and every imported row jumped the media queue one at a time
			// (v4-spec §4b). This is the only place that knows better.
			ev.IsHistorical = true
			e.emitWithMeta(chanMeta, actorMeta, ev)
			// Reactions that were already on this message when it was imported hang
			// off the WebMessageInfo, which mapMessage never sees (v3-spec §4).
			e.emitHistoryReactions(c, parsed, ev, r, now)
			e.backfill.mu.Lock()
			e.backfill.messages++
			// Defensive: chatsDone is seeded in New() and reset per run, but a
			// daemon-pushed HistorySync can arrive before any run, so never assume
			// it's non-nil here (a nil-map write panics and drops the whole sync).
			if e.backfill.chatsDone == nil {
				e.backfill.chatsDone = map[string]bool{}
			}
			e.backfill.chatsDone[jidString(c.canonicalJID(chatJID))] = true
			done := len(e.backfill.chatsDone)
			total := e.backfill.chatsTotal
			msgs := e.backfill.messages
			active := e.backfill.active
			e.backfill.mu.Unlock()
			// Only emit non-done backfill progress while the run is still active.
			// After completion (banner cleared), background on-demand pagination
			// keeps INGESTING older messages (which nudge the inbox) but must NOT
			// emit fresh non-done progress — that would re-open the import banner
			// (contract §R7.2: "the banner must not re-open"). The message itself
			// was still emitted above, so nothing is lost.
			if active {
				_ = e.w.Progress("backfill", done, total, msgs, false, r)
			}
		}
	}

	// ONE line per history-sync payload, with the shape of what the server sent and
	// what survived each filter. This is the record that was missing when a re-sync
	// delivered a fraction of the expected history: without it, a bootstrap-only
	// session and a full sync look identical in the log.
	e.logf("history-sync: type=%s chunk=%d progress=%d%% convs=%d/%d in-range msgs=%d seen / %d emitted / %d out-of-range / %d unparsed (range %s)",
		hs.Data.GetSyncType(), hs.Data.GetChunkOrder(), hs.Data.GetProgress(),
		convsInRange, convsSeen, msgsSeen, msgsEmitted, msgsOutOfRange, msgsUnparsed, r)

	// The same counters on the wire. A log line is only readable AFTER the fact by
	// a human; the worker decides whether history actually arrived, and it must
	// decide from what the server sent rather than infer it from the shape of its
	// own DB (which cannot distinguish "few messages sent" from "many dropped").
	counts := protocol.HistorySync{
		SyncType:         hs.Data.GetSyncType().String(),
		Chats:            convsSeen,
		ChatsInRange:     convsInRange,
		MessagesSeen:     msgsSeen,
		MessagesInRange:  msgsInRange,
		MessagesEmitted:  msgsEmitted,
		MessagesFiltered: msgsOutOfRange + msgsUnparsed,
		OnDemand:         hs.Data.GetSyncType() == waHistorySync.HistorySync_ON_DEMAND,
	}
	// Only when the server actually sent one — 0 and "absent" mean different
	// things, and the worker keeps the field optional for exactly that reason.
	if hs.Data.Progress != nil {
		p := int(hs.Data.GetProgress())
		counts.Progress = &p
	}
	_ = e.w.HistorySync(counts)

	// Arm the back-pagination paginator, ONCE per import run, now that this batch
	// has produced real anchors. Import cannot do this itself: at Import time
	// e.oldestPerChat is empty (trackAnchor only fills it from mapped messages), so
	// the paginator found no chat with a gap, sent nothing, and settled instantly —
	// closing the run before its first batch had even arrived. Arming here is
	// bounded: no batch ever arriving means never arming, and the quiet watcher's
	// zero-batch deadline terminates that run instead.
	//
	// This runs BEFORE maybeCompleteBackfill so the arm happens while the run is
	// still active; the paginator itself deliberately keeps ingesting older history
	// after the banner clears (see the `active` gate on progress above).
	if run, armed := e.armPaginator(); armed {
		e.logf("paginator: arming for import run %d after the first history batch (%d anchors, range %s)", run, e.anchorCount(), r)
		e.requestOlderHistory(r)
	}

	// Re-arm the name sweep now that this batch has actually loaded data (contract
	// §R3, bug: RC7). The connect+5s one-shot fires while history is still streaming,
	// so it sweeps a near-empty candidate set and GetUserInfo never runs. A batch
	// carrying conversations (new candidate DMs) or pushnames (store side-data) means
	// there is fresh work; kick a sweep. refreshInProgress single-flights it against
	// the connect/sync-complete triggers, so overlaps collapse to one in-flight sweep.
	if len(hs.Data.GetConversations()) > 0 || len(hs.Data.GetPushnames()) > 0 {
		go e.refreshKnownNames("history-sync")
	}

	// Completion: fire done + backfill_complete when the history-sync server
	// progress reaches ~100% OR every in-range chat has been touched (contract
	// §R6.3). The quiet-window watcher (contract §R7.2) is the fallback for large
	// imports where chats_done plateaus below chats_total forever. This clears the
	// banner instead of leaving a permanent "N/293" or "720/897".
	e.maybeCompleteBackfill(hs, r)
}

// parseWebMessage turns a history-sync WebMessageInfo into a parsed message,
// through the test seam when one is installed. A batch can reach the history loop
// with no client at all (drainPendingHistory runs off SetRange), so the nil check
// is a real guard, not just test scaffolding.
func (e *Engine) parseWebMessage(chatJID types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error) {
	if e.parseWebMsgFn != nil {
		return e.parseWebMsgFn(chatJID, webMsg)
	}
	if e.client == nil {
		return nil, fmt.Errorf("no client to parse history message")
	}
	return e.client.ParseWebMessage(chatJID, webMsg)
}

// emitHistoryReactions synthesizes one reaction event per entry in an imported
// message's Reactions list (v3-spec §4). Historical reactions are reachable ONLY
// here: they hang off the WebMessageInfo, and the *waE2E.Message ParseWebMessage
// hands back carries none of them, so a chat that was already reacted to when it
// was imported produced no reaction rows at all.
//
// `ev` is the event just emitted for the ENCLOSING message, which makes every id
// fall out of it: ev.ExternalID is "<canonicalChat>/<webMsg.Key.ID>", i.e. the
// target — the reaction's own key names the reaction, never its target — and every
// row therefore joins against a message this same batch has already ingested.
func (e *Engine) emitHistoryReactions(c *canonicalizer, parsed *events.Message, ev protocol.Event, r protocol.Range, now time.Time) {
	reactions := parsed.SourceWebMsg.GetReactions()
	if len(reactions) == 0 {
		return
	}
	isDM := chatKind(parsed.Info.Chat) == "dm"
	for _, rx := range reactions {
		key := rx.GetKey()
		ts := parsed.Info.Timestamp
		if ms := rx.GetSenderTimestampMS(); ms != 0 {
			ts = time.UnixMilli(ms)
		}
		// Same window as the messages themselves, so an import can't smuggle in
		// reactions from outside the range the user picked.
		if !rangefilter.MessageInRange(r, ts, now) {
			continue
		}
		actor := reactionActor(c, key, ev.ChannelExtID, isDM)
		if actor == "" {
			e.logf("history reaction on %s dropped: no attributable reactor", ev.ExternalID)
			continue
		}
		id := ev.ChannelExtID + "/" + key.GetID()
		if key.GetID() == "" {
			id = syntheticReactionID(ev.ChannelExtID, ev.ExternalID, actor, rx.GetText())
		}
		rev := protocol.Event{
			ExternalID:   id,
			ChannelExtID: ev.ChannelExtID,
			ActorExtID:   actor,
			TS:           protocol.FormatTime(ts),
			Kind:         protocol.KindReaction,
			// Empty text is a REMOVED reaction, which the worker already handles.
			Text:              rx.GetText(),
			FromMe:            key.GetFromMe(),
			IsHistorical:      true,
			ReplyToExternalID: ev.ExternalID,
			Raw: map[string]any{
				"id":        key.GetID(),
				"chat":      ev.ChannelExtID,
				"sender":    actor,
				"type":      string(protocol.KindReaction),
				"timestamp": protocol.FormatTime(ts),
			},
		}
		e.emitWithMeta(nil, e.reactionActorMeta(c, actor, key.GetFromMe()), rev)
	}
}

// reactionActor resolves who reacted. A group reaction names its participant on
// the key; a DM reaction leaves it empty because there are only two people it can
// be, so FromMe picks between us and the peer (whose JID IS the DM's channel id).
// Returns "" when the reactor cannot be named at all — the worker collapses
// reactions BY ACTOR, so an unattributable reaction is worse than no reaction.
func reactionActor(c *canonicalizer, key *waCommon.MessageKey, chatExtID string, isDM bool) string {
	if part := key.GetParticipant(); part != "" {
		if j, err := types.ParseJID(part); err == nil && j.User != "" {
			return jidString(c.canonicalJID(j))
		}
	}
	if key.GetFromMe() {
		return jidString(c.selfPN)
	}
	if isDM {
		return chatExtID
	}
	return ""
}

// syntheticReactionID derives a STABLE external id for a reaction whose key
// carries no id of its own. Without one, every re-import would insert the same
// reaction again under a fresh id. Target + reactor + emoji is what identifies a
// reaction, so hashing exactly those makes the id reproducible across runs.
func syntheticReactionID(chatExtID, target, actor, emoji string) string {
	return chatExtID + "/rx-" + sha256Sum([]byte(target + "\x00" + actor + "\x00" + emoji))[:32]
}

// reactionActorMeta introduces the reactor so the reaction row has an actor to
// join against. A historical reactor is frequently someone who never sent a
// message in the imported window, so this is the only line that ever names them.
func (e *Engine) reactionActorMeta(c *canonicalizer, actorExtID string, fromMe bool) *protocol.Actor {
	ac := &protocol.Actor{SourceExtID: actorExtID, IsSelf: fromMe}
	if j, err := types.ParseJID(actorExtID); err == nil && !j.IsEmpty() {
		ac.Handle = handleFromJID(j)
		ac.DisplayName = e.contactNameForDM(c, j)
	}
	if fromMe {
		ac.DisplayName = selfLabel(e.pushName())
	}
	return ac
}

// maxPendingHistory bounds the pre-range HistorySync buffer so a slow onboarding
// (or a user who never picks a range) can't grow it without limit. WhatsApp
// delivers the initial history in a small number of batches, so this is generous;
// on overflow we install the default window and process directly rather than lose
// data.
const maxPendingHistory = 256

// bufferIfNoRange buffers hs and returns true when no import range is installed
// yet, so the user's selection (installed via Import/SetRange) filters it. The
// haveImport check and the append happen under ONE lock so a concurrent Import
// that installs a range and drains cannot strand this batch in the gap between a
// separate check and append. On buffer overflow it installs the bounded default,
// flushes, and returns false so the caller processes hs directly — memory stays
// bounded and no history is lost.
func (e *Engine) bufferIfNoRange(hs *events.HistorySync) bool {
	e.mu.Lock()
	if e.haveImport {
		e.mu.Unlock()
		return false
	}
	if len(e.pendingHistory) < maxPendingHistory {
		e.pendingHistory = append(e.pendingHistory, hs)
		e.mu.Unlock()
		return true
	}
	// Overflow: the user hasn't picked a range in time. Install the bounded
	// default so we stop buffering and process directly from here on.
	e.importRange = defaultPushedRange
	e.haveImport = true
	e.mu.Unlock()
	e.logf("history-sync buffer full (%d batches, no range selected yet); flushing at default %s", maxPendingHistory, defaultPushedRange)
	e.drainPendingHistory()
	return false
}

// drainPendingHistory processes every buffered pre-range HistorySync batch
// through the normal range filter. Callers (Import/SetRange, or the overflow
// path) install the range BEFORE calling, so the buffered history is filtered by
// the user's selection. Safe to call when the buffer is empty.
func (e *Engine) drainPendingHistory() {
	e.mu.Lock()
	pending := e.pendingHistory
	e.pendingHistory = nil
	e.mu.Unlock()
	for _, hs := range pending {
		e.processHistorySync(hs)
	}
}

// effectivePushedRange returns the range onHistorySync should filter a batch by,
// given the installed range r and whether a range has been installed at all
// (have = a user Import/Extend OR a connect-time SetRange ran). When a range is
// installed it is honored verbatim. When NONE is installed — a range-less daemon
// receiving WhatsApp's automatic post-pairing HistorySync — it falls back to a
// BOUNDED defaultPushedRange rather than RangeAll, so a daemon with no range set
// can never flood ALL history (the "7-day pick got history back to January" bug,
// which also overloaded extraction with ~6000 messages). The worker installs the
// persisted/default range via set_range at connect, so `have` is normally true
// by the time pushed history lands; this is the standalone-daemon safety net.
func effectivePushedRange(r protocol.Range, have bool) protocol.Range {
	if !have {
		return defaultPushedRange
	}
	return r
}

// absorbPushnames records the JID->pushname entries carried in a HistorySync
// batch (contract §R6.1). Keyed by canonical user JID so live and history
// lookups coincide.
func (e *Engine) absorbPushnames(hs *events.HistorySync) {
	if hs.Data == nil {
		return
	}
	pushnames := hs.Data.GetPushnames()
	if len(pushnames) == 0 {
		return
	}
	c := e.newCanonicalizer()
	for _, pn := range pushnames {
		id := pn.GetID()
		name := pn.GetPushname()
		if id == "" || name == "" {
			continue
		}
		j, err := types.ParseJID(id)
		if err != nil {
			continue
		}
		e.setHistPushName(c.canonicalJID(j), name)
	}
}

// absorbLIDMappings persists the LID<->PN pairs a HistorySync batch carries into
// the local LID store (bug: RC5). Two sources:
//   - the batch-wide PhoneNumberToLidMappings (pnJID <-> lidJID), and
//   - each Conversation's LidJID paired with its PN thread id (Conversation.ID).
//
// With these in the store, a later @lid-addressed message from the same business
// canonicalizes to its PN and a saved-contact / verified-name lookup hits.
// READ-ONLY: StoreLIDPNMapping only writes the local session store, never to
// WhatsApp, and it self-orders the pair (no-op unless it's exactly one LID + one
// PN).
func (e *Engine) absorbLIDMappings(hs *events.HistorySync) {
	if hs.Data == nil || e.client == nil {
		return
	}
	store := func(a, b types.JID) {
		if a.IsEmpty() || b.IsEmpty() {
			return
		}
		e.client.StoreLIDPNMapping(context.Background(), a.ToNonAD(), b.ToNonAD())
	}
	for _, m := range hs.Data.GetPhoneNumberToLidMappings() {
		pn, perr := types.ParseJID(m.GetPnJID())
		lid, lerr := types.ParseJID(m.GetLidJID())
		if perr != nil || lerr != nil {
			continue
		}
		store(lid, pn)
	}
	for _, conv := range hs.Data.GetConversations() {
		lidStr := conv.GetLidJID()
		if lidStr == "" {
			continue
		}
		lid, lerr := types.ParseJID(lidStr)
		pn, perr := types.ParseJID(conv.GetID())
		if lerr != nil || perr != nil {
			continue
		}
		// Only a real PN DM thread pairs with a LID; skip groups/broadcasts.
		if pn.Server != types.DefaultUserServer {
			continue
		}
		store(lid, pn)
	}
}

// conversationName returns the conversation's own display name from a
// history-sync Conversation (contract §R6.1): the phone-shown name, preferring
// Name, then DisplayName. Empty when neither is set.
func conversationName(conv *waHistorySync.Conversation) string {
	return firstNonEmpty(conv.GetName(), conv.GetDisplayName())
}

// maybeCompleteBackfill fires progress done:true + backfill_complete once a
// blocking history sync signals completion (contract §R6.3), or leaves the run
// open for the quiet watcher / paginator otherwise (contract §R7.2). It fires
// when EITHER:
//   - the history-sync SERVER progress reaches ~100% (HistorySync.GetProgress()
//     >= serverProgressComplete), OR
//   - every in-range chat we know about has at least one imported message
//     (total>0 && done>=total).
//
// If NEITHER holds — the common large/entire-import case, where WhatsApp never
// delivers history for inactive chats so done plateaus below total forever —
// this leaves the run open; the quiet-window watcher (watchQuietCompletion,
// contract §R7.2) then completes it once history-sync batches stop arriving,
// regardless of chats_done vs chats_total.
//
// ON_DEMAND batches are the extend paginator's responses; the paginator owns the
// extend run's completion (contract §R6.4), so here we only surface incremental
// (non-done) progress for them and never the terminal done/backfill_complete.
// finishBackfill is the once-only guard shared with the quiet watcher and the
// paginator, so completion is emitted EXACTLY ONCE per run.
func (e *Engine) maybeCompleteBackfill(hs *events.HistorySync, r protocol.Range) {
	syncType := hs.Data.GetSyncType()
	progress := hs.Data.GetProgress()
	onDemand := syncType == waHistorySync.HistorySync_ON_DEMAND

	e.backfill.mu.Lock()
	if !e.backfill.active {
		e.backfill.mu.Unlock()
		return
	}
	total := e.backfill.chatsTotal
	done := len(e.backfill.chatsDone)
	msgs := e.backfill.messages
	run := e.backfill.run
	e.backfill.mu.Unlock()

	if onDemand {
		// Surface progress but leave completion to the paginator (contract §R6.4).
		_ = e.w.Progress("backfill", done, total, msgs, false, r)
		return
	}

	// A blocking sync (INITIAL_BOOTSTRAP/RECENT/FULL) is "complete enough" for the
	// import banner when the server reports (near) full progress OR every in-range
	// chat has been touched. Otherwise leave the run open for the quiet watcher —
	// do NOT wait for done>=total, which never arrives on a large import.
	serverComplete := progress >= serverProgressComplete
	coveredAll := total > 0 && done >= total
	if !serverComplete && !coveredAll {
		return
	}

	e.finishBackfill(run, r, done, total, msgs)
}

// serverProgressComplete is the HistorySync.GetProgress() threshold (percent) at
// which a blocking history sync is treated as server-complete (contract §R7.2:
// "~100"). We use ~99 rather than a strict 100 because the server's reported
// progress can top out just under 100 on a finished sync.
const serverProgressComplete = 99

func conversationLastActivity(conv *waHistorySync.Conversation) time.Time {
	// Use the conversation's last message timestamp when available.
	if ts := conv.GetLastMsgTimestamp(); ts != 0 {
		return time.Unix(int64(ts), 0)
	}
	var newest time.Time
	for _, hm := range conv.GetMessages() {
		wm := hm.GetMessage()
		if wm == nil {
			continue
		}
		t := time.Unix(int64(wm.GetMessageTimestamp()), 0)
		if t.After(newest) {
			newest = t
		}
	}
	return newest
}

// emitWithMeta emits channel + actor before the event, honoring the contract
// ordering guarantee. A channel/actor is (re-)emitted when it is seen for the
// first time OR when a BETTER name is now known than what we last emitted
// (contract §R2.4, bug 4: late-arriving contact/pushname/group-subject
// upgrades). The worker upserts on source_ext_id, so a repeat line with an
// improved name UPDATES the stored name.
func (e *Engine) emitWithMeta(ch *protocol.Channel, ac *protocol.Actor, ev protocol.Event) {
	if ch != nil {
		if e.shouldEmitChannel(ch.SourceExtID, ch.Name) {
			_ = e.w.Channel(*ch)
		}
	}
	if ac != nil {
		if e.shouldEmitActor(ac.SourceExtID, ac.DisplayName) {
			_ = e.w.Actor(*ac)
		}
	}
	_ = e.w.Event(ev)
}

// shouldEmitChannel reports whether to emit a channel line for id with name,
// recording it as emitted. It returns true on first sight or when name is a
// strict improvement over the last emitted name (see nameIsBetter).
func (e *Engine) shouldEmitChannel(id, name string) bool {
	if id == "" {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	prev, seen := e.emittedChanName[id]
	if seen && !nameIsBetter(name, prev) {
		return false
	}
	e.emittedChans[id] = true
	e.emittedChanName[id] = name
	return true
}

// shouldEmitActor mirrors shouldEmitChannel for actors.
func (e *Engine) shouldEmitActor(id, name string) bool {
	if id == "" {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	prev, seen := e.emittedActName[id]
	if seen && !nameIsBetter(name, prev) {
		return false
	}
	e.emittedActs[id] = true
	e.emittedActName[id] = name
	return true
}

// nameIsBetter reports whether newName is a strict improvement over prev worth
// re-emitting. A "real" name (not a bare number/JID) beats a numeric fallback;
// otherwise only a changed value counts. This keeps late upgrades (number ->
// "Hrishikesh") flowing while avoiding churn.
func nameIsBetter(newName, prev string) bool {
	if newName == "" || newName == prev {
		return false
	}
	newIsReal := !looksLikeNumberLabel(newName)
	prevIsReal := !looksLikeNumberLabel(prev)
	if newIsReal && !prevIsReal {
		return true // upgraded from a number to a real name
	}
	if !newIsReal && prevIsReal {
		return false // never downgrade a real name back to a number
	}
	// Same class (both real or both numeric): re-emit only if it actually
	// changed to a real name we didn't have (avoids number<->number churn).
	return newIsReal
}

// looksLikeNumberLabel reports whether s is just a phone-number/JID-ish label
// (digits, optional leading +) OR a WhatsApp privacy-masked number
// (e.g. "+91••••••15") rather than a human name. Both count as "not a real
// name", so name upgrades never prefer them and we never STORE one as a
// display name — a masked history-sync/pushname value is rejected here so
// resolution falls back to the real number/JID or a clean self label
// (contract §R7.3, bug: rows of stars incl. the user's own number).
func looksLikeNumberLabel(s string) bool {
	if s == "" {
		return true
	}
	if isMaskedNumberLabel(s) {
		return true
	}
	i := 0
	if s[0] == '+' {
		i = 1
	}
	if i == len(s) {
		return true
	}
	for ; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// isMaskGlyph reports whether r is one of the characters WhatsApp uses to REDACT
// the hidden middle of a privacy-masked phone number (number-hidden / LID-only
// contacts): asterisks, bullets, mid-dots and their unicode variants. WhatsApp
// hands these masked strings to the client as the contact's own "name"; we do
// NOT synthesize them (contract §R7.3). ASCII '.' is included but, on its own,
// is common in real text — isMaskedNumberLabel's ≥2-glyph + no-letter gate keeps
// ordinary names/numbers from being misread as masked.
func isMaskGlyph(r rune) bool {
	switch r {
	case '*', '.',
		'·', // · MIDDLE DOT
		'•', // • BULLET
		'‧', // ‧ HYPHENATION POINT
		'∙', // ∙ BULLET OPERATOR
		'⋅', // ⋅ DOT OPERATOR
		'∗', // ∗ ASTERISK OPERATOR
		'✱', // ✱ HEAVY ASTERISK
		'⁎', // ⁎ LOW ASTERISK
		'●', // ● BLACK CIRCLE
		'○', // ○ WHITE CIRCLE
		'…', // … HORIZONTAL ELLIPSIS
		'＊', // ＊ FULLWIDTH ASTERISK
		'．': // ． FULLWIDTH FULL STOP
		return true
	}
	return false
}

// isMaskedNumberLabel reports whether s is a WhatsApp privacy-masked number: a
// phone-number-shaped string whose middle is redacted with mask glyphs
// (e.g. "+91••••••15", "+91 ***** **015", "··········"). It requires ≥2 mask
// glyphs, NO letters (a real name is never masked) and only phone-ish
// characters otherwise, so a normal name/number is never misclassified
// (contract §R7.3).
func isMaskedNumberLabel(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	masks := 0
	for _, r := range s {
		switch {
		case isMaskGlyph(r):
			masks++
		case r >= '0' && r <= '9':
			// digit
		case r == '+' || r == '-' || r == '(' || r == ')' || r == ' ' || r == '/' || r == '~':
			// phone-ish separators
		case unicode.IsLetter(r):
			return false // a real name, not a masked number
		default:
			return false // other content: not a clean masked number
		}
	}
	return masks >= 2
}

// mapMessage converts a whatsmeow message into the canonical Event + channel +
// actor. Returns ok=false for messages we intentionally drop (e.g. empty).
//
// Every emitted chat/actor JID is CANONICALIZED (device-stripped + LID->PN
// normalized) so the same conversation/person produces one stable key across
// live vs history-sync vs reruns (contract §R2.4, bug 7).
func (e *Engine) mapMessage(info types.MessageInfo, msg *waE2E.Message) (protocol.Event, *protocol.Channel, *protocol.Actor, bool) {
	if msg == nil {
		return protocol.Event{}, nil, nil, false
	}

	// Filter noise chats entirely (contract §R4.3, bug 17): status@broadcast,
	// @newsletter, @broadcast. Normal groups/DMs pass.
	if skipChatJID(info.Chat) {
		return protocol.Event{}, nil, nil, false
	}

	kind, text, dl := classify(msg)
	pm := protocolTarget(msg)
	edits, revokes := editRevokeTarget(pm, info.Edit)
	// Drop contentless system/protocol events (e2e/security/history-sync/
	// notification with no user text) — these caused the self-chat "System
	// message" spam (contract §R4.3, bug 17). We only drop when there is neither
	// text nor downloadable media, so genuinely meaningful events still flow.
	// An edit/revoke tombstone legitimately carries no text of its own; its whole
	// payload is the id of the message it replaces, so it must survive this
	// (rich-media-spec §5). A reaction removal is likewise text-less but is never
	// kind system, so the rule never saw it (§6).
	if kind == protocol.KindSystem && text == "" && dl == nil && !edits && !revokes {
		return protocol.Event{}, nil, nil, false
	}

	c := e.newCanonicalizer()

	// Resolve the peer (chat) and sender to canonical PN JIDs.
	//
	// For a DM the chat JID IS the peer; its alt (RecipientAlt) is the peer's
	// other address. For the sender, SenderAlt is the sender's other address.
	// We feed those per-message hints into resolution first (cheapest, always
	// present when whatsmeow knows the mapping) and fall back to the LID store.
	chatCanon := e.canonicalChatJID(c, info)
	var senderCanon types.JID
	if info.IsFromMe {
		// from_me: the actor is US; canonicalize to our own PN so the self actor
		// is one stable identity (bug 2 / self chat).
		senderCanon = c.selfPN
		if senderCanon.IsEmpty() {
			senderCanon = c.canonicalJID(info.Sender)
		}
	} else {
		senderCanon = e.canonicalUserJID(c, info.Sender, info.SenderAlt)
	}

	chatJID := jidString(chatCanon)
	senderJID := jidString(senderCanon)
	msgID := info.ID

	e.trackAnchor(info, chatJID)

	ev := protocol.Event{
		ExternalID:   chatJID + "/" + msgID,
		ChannelExtID: chatJID,
		ActorExtID:   senderJID,
		TS:           protocol.FormatTime(info.Timestamp),
		FromMe:       info.IsFromMe,
		Raw: map[string]any{
			"id":        msgID,
			"chat":      chatJID,
			"sender":    senderJID,
			"type":      info.Type,
			"timestamp": protocol.FormatTime(info.Timestamp),
		},
	}

	ev.Kind = kind
	ev.Text = text

	// Reactions (contract §R5.3, bug 3a): a ReactionMessage targets an existing
	// message. We surface it as its OWN event (kind=reaction) whose text is the
	// emoji ("" = reaction removed) and whose reply_to_external_id points at the
	// TARGET message's external_id ("<canonicalChat>/<targetMsgID>"). Do NOT drop
	// it. The target's chat is normally THIS chat, but the ReactionMessage.Key may
	// carry an explicit RemoteJID (canonicalized) — prefer it, else use chatCanon.
	//
	// EncReactionMessage (community reactions) names its target the same way but
	// keeps the emoji encrypted, so it arrives as a removal-shaped reaction
	// (rich-media-spec §6).
	if kind == protocol.KindReaction {
		unwrapped := unwrapMessage(msg)
		if rm := unwrapped.GetReactionMessage(); rm != nil {
			ev.ReplyToExternalID = e.targetExternalID(c, rm.GetKey(), chatCanon)
		} else if erm := unwrapped.GetEncReactionMessage(); erm != nil {
			ev.ReplyToExternalID = e.targetExternalID(c, erm.GetTargetMessageKey(), chatCanon)
		}
	}

	// The message an edit replaces / a revoke deletes (rich-media-spec §2/§5).
	// The event is still emitted; the worker folds it into the original row.
	if target := e.targetExternalID(c, pm.GetKey(), chatCanon); target != "" {
		if edits {
			ev.EditOfExternalID = target
		}
		if revokes {
			ev.RevokeOfExternalID = target
		}
	}

	// One ContextInfo carries all three: the quoted reply (contract §R5.4, bug 3b)
	// as reply_to = {external_id, text, actor_ext_id}, plus the forwarding flag
	// and the mention list (rich-media-spec §2).
	if ci := messageContextInfo(msg); ci != nil {
		if rt := e.quotedReplyTo(c, ci, chatCanon); rt != nil {
			ev.ReplyTo = rt
		}
		ev.IsForwarded = ci.GetIsForwarded()
		ev.MentionedExtIDs = mentionedExtIDs(c, ci)
		if dl == nil && ev.Kind == protocol.KindMessage {
			// The ad card a click-to-WhatsApp conversation opens with. Its thumbnail
			// is the only picture of the advertised thing the user ever saw, and it
			// rides on the CONTEXT of an otherwise ordinary message (v3-spec §5). The
			// event takes the media's kind exactly as a business card with a header
			// picture does — the worker's media reader is selected BY kind, so a
			// picture on a kind:message row would be stored and never read.
			if ad := externalAdReplyMedia(ci); ad != nil {
				dl = ad
				ev.Kind = protocol.KindImage
			}
		}
	}

	ev.Link = e.messageLink(chatJID, msgID, msg)

	if dl != nil {
		if md, err := e.downloadMedia(chatJID, msgID, dl); err != nil {
			e.logf("media download failed for %s: %v", ev.ExternalID, err)
		} else {
			ev.Media = md
		}
	}

	// Names: resolve using the canonical (PN) JIDs so contact lookups hit even for
	// LID-addressed messages. When no REAL name is known we now emit an EMPTY
	// Channel.Name / Actor.DisplayName rather than forcing the phone number / bare
	// LID as the name (bug: RC1). The phone/handle is still carried on the Actor's
	// Handle field and, for both, via source_ext_id (the JID), so the frontend
	// pretty-prints the number instead of pinning it as the identity — and a real
	// name learned later (contact sync / verified-name recovery) upgrades cleanly
	// instead of being blocked by a "real-looking" number already stored
	// (contract §3). The self chat is the ONE exception: it keeps a clean self
	// label ("You"/pushname), never our own number/mask (contract §R7.3).
	chName := e.chatName(info, chatCanon)
	if chName == "" && !c.selfPN.IsEmpty() && sameUser(chatCanon, c.selfPN) {
		// The self chat ("message yourself"): a real history-sync name (e.g. "You
		// (Notes)") already won inside chatName above; otherwise a clean self label.
		chName = selfLabel(e.pushName())
	}
	acName := e.actorName(info, senderCanon)

	// The verified-name certificate on an INCOMING DM is proof the peer is a WABiz
	// account (v3-spec §5) — the same field chatName already reads for the display
	// name. A business posting into a group says nothing about the group.
	if !info.IsFromMe && chatKind(info.Chat) == "dm" && verifiedName(info) != "" {
		e.noteBusinessChat(chatCanon)
	}

	ch := &protocol.Channel{
		SourceExtID: chatJID,
		Name:        chName,
		Kind:        chatKind(info.Chat),
		IsBusiness:  e.businessChannel(chatCanon),
	}
	ac := &protocol.Actor{
		SourceExtID: senderJID,
		DisplayName: acName,
		Handle:      handleFromJID(senderCanon),
		IsSelf:      info.IsFromMe,
	}
	return ev, ch, ac, true
}

// targetExternalID builds the external_id of the message a MessageKey points at
// — the target of a reaction (contract §R5.3), an edit or a revoke
// (rich-media-spec §5): "<canonicalChatOfTarget>/<Key.ID>". The key's RemoteJID
// names the target's chat; we canonicalize it so it matches the external_id we
// emitted for that message. When RemoteJID is absent (common for a same-chat
// reference), the target lives in the referring message's own chat
// (fallbackChat, already canonical). Returns "" when the key has no message ID.
func (e *Engine) targetExternalID(c *canonicalizer, key *waCommon.MessageKey, fallbackChat types.JID) string {
	if key == nil || key.GetID() == "" {
		return ""
	}
	targetChat := fallbackChat
	if remote := key.GetRemoteJID(); remote != "" {
		if j, err := types.ParseJID(remote); err == nil && !j.IsEmpty() {
			targetChat = c.canonicalJID(j)
		}
	}
	chat := jidString(targetChat)
	if chat == "" {
		return ""
	}
	return chat + "/" + key.GetID()
}

// quotedReplyTo builds the reply_to reference for a message that quotes another
// (contract §R5.4), from the reply ContextInfo (StanzaID / QuotedMessage /
// Participant) the caller pulled off whichever sub-message carries it:
//   - external_id  "<canonicalChat>/<StanzaID>"  (chat = ContextInfo.RemoteJID
//     when present — e.g. a quoted group message referenced from elsewhere —
//     else the reply's own chat)
//   - text         the extracted text of the quoted message (reusing classify)
//   - actor_ext_id the canonical JID of the quoted sender (Participant)
//
// Returns nil when the message is not a reply (no ContextInfo with a StanzaID).
func (e *Engine) quotedReplyTo(c *canonicalizer, ci *waE2E.ContextInfo, replyChat types.JID) *protocol.ReplyTo {
	if ci.GetStanzaID() == "" {
		return nil
	}
	quotedChat := replyChat
	if remote := ci.GetRemoteJID(); remote != "" {
		if j, err := types.ParseJID(remote); err == nil && !j.IsEmpty() {
			quotedChat = c.canonicalJID(j)
		}
	}
	chat := jidString(quotedChat)
	if chat == "" {
		return nil
	}

	var quotedText string
	if qm := ci.GetQuotedMessage(); qm != nil {
		// Reuse the same extractor the top-level mapper uses so quoted business
		// templates/media captions render their real text too.
		_, quotedText, _ = classify(qm)
	}

	var actorExtID string
	if part := ci.GetParticipant(); part != "" {
		if j, err := types.ParseJID(part); err == nil && !j.IsEmpty() {
			actorExtID = jidString(c.canonicalJID(j))
		}
	}

	return &protocol.ReplyTo{
		ExternalID: chat + "/" + ci.GetStanzaID(),
		Text:       quotedText,
		ActorExtID: actorExtID,
	}
}

// messageContextInfo returns the reply ContextInfo carried by a message, looking
// across the sub-message types that can be replies (ExtendedText is the common
// one; media/business types can also quote). Returns nil when none is present.
//
// NOTE: this is the reply/quote ContextInfo (StanzaID/QuotedMessage), NOT the
// top-level Message.MessageContextInfo (message-secret metadata), which is a
// different, unrelated field.
func messageContextInfo(msg *waE2E.Message) *waE2E.ContextInfo {
	return messageContextInfoDepth(msg, 0)
}

// maxNestedContextDepth bounds the recursion into wrappers that carry their
// ContextInfo on the message they nest (payment notes, comments, poll V4).
const maxNestedContextDepth = 4

func messageContextInfoDepth(msg *waE2E.Message, depth int) *waE2E.ContextInfo {
	// Unwrap containers first so a wrapped reply (e.g. an ephemeral quoted
	// message) still surfaces its ContextInfo (contract §R6.2).
	msg = unwrapMessage(msg)
	if msg == nil || depth > maxNestedContextDepth {
		return nil
	}
	switch {
	case msg.GetExtendedTextMessage() != nil:
		return msg.GetExtendedTextMessage().GetContextInfo()
	case msg.GetImageMessage() != nil:
		return msg.GetImageMessage().GetContextInfo()
	case msg.GetVideoMessage() != nil:
		return msg.GetVideoMessage().GetContextInfo()
	case msg.GetPtvMessage() != nil:
		return msg.GetPtvMessage().GetContextInfo()
	case msg.GetAudioMessage() != nil:
		return msg.GetAudioMessage().GetContextInfo()
	case msg.GetDocumentMessage() != nil:
		return msg.GetDocumentMessage().GetContextInfo()
	case msg.GetStickerMessage() != nil:
		return msg.GetStickerMessage().GetContextInfo()
	case msg.GetStickerPackMessage() != nil:
		return msg.GetStickerPackMessage().GetContextInfo()
	case msg.GetLocationMessage() != nil:
		return msg.GetLocationMessage().GetContextInfo()
	case msg.GetLiveLocationMessage() != nil:
		return msg.GetLiveLocationMessage().GetContextInfo()
	case msg.GetContactMessage() != nil:
		return msg.GetContactMessage().GetContextInfo()
	case msg.GetContactsArrayMessage() != nil:
		return msg.GetContactsArrayMessage().GetContextInfo()
	case msg.GetTemplateMessage() != nil:
		return msg.GetTemplateMessage().GetContextInfo()
	case msg.GetListMessage() != nil:
		return msg.GetListMessage().GetContextInfo()
	case msg.GetButtonsMessage() != nil:
		return msg.GetButtonsMessage().GetContextInfo()
	case msg.GetInteractiveMessage() != nil:
		return msg.GetInteractiveMessage().GetContextInfo()
	case msg.GetProductMessage() != nil:
		return msg.GetProductMessage().GetContextInfo()
	case msg.GetOrderMessage() != nil:
		return msg.GetOrderMessage().GetContextInfo()
	case msg.GetTemplateButtonReplyMessage() != nil:
		return msg.GetTemplateButtonReplyMessage().GetContextInfo()
	case msg.GetListResponseMessage() != nil:
		return msg.GetListResponseMessage().GetContextInfo()
	case msg.GetButtonsResponseMessage() != nil:
		return msg.GetButtonsResponseMessage().GetContextInfo()
	case msg.GetInteractiveResponseMessage() != nil:
		return msg.GetInteractiveResponseMessage().GetContextInfo()
	case msg.GetGroupInviteMessage() != nil:
		return msg.GetGroupInviteMessage().GetContextInfo()
	case msg.GetNewsletterAdminInviteMessage() != nil:
		return msg.GetNewsletterAdminInviteMessage().GetContextInfo()
	case msg.GetNewsletterFollowerInviteMessageV2() != nil:
		return msg.GetNewsletterFollowerInviteMessageV2().GetContextInfo()
	case msg.GetAlbumMessage() != nil:
		return msg.GetAlbumMessage().GetContextInfo()
	case msg.GetEventMessage() != nil:
		return msg.GetEventMessage().GetContextInfo()
	case msg.GetEventInviteMessage() != nil:
		return msg.GetEventInviteMessage().GetContextInfo()
	case msg.GetPollCreationMessage() != nil:
		return msg.GetPollCreationMessage().GetContextInfo()
	case msg.GetPollCreationMessageV2() != nil:
		return msg.GetPollCreationMessageV2().GetContextInfo()
	case msg.GetPollCreationMessageV3() != nil:
		return msg.GetPollCreationMessageV3().GetContextInfo()
	case msg.GetPollCreationMessageV5() != nil:
		return msg.GetPollCreationMessageV5().GetContextInfo()
	case msg.GetPollCreationMessageV6() != nil:
		return msg.GetPollCreationMessageV6().GetContextInfo()
	case msg.GetPollResultSnapshotMessage() != nil:
		return msg.GetPollResultSnapshotMessage().GetContextInfo()
	case msg.GetPollResultSnapshotMessageV3() != nil:
		return msg.GetPollResultSnapshotMessageV3().GetContextInfo()
	case msg.GetRequestPhoneNumberMessage() != nil:
		return msg.GetRequestPhoneNumberMessage().GetContextInfo()
	case msg.GetSplitPaymentMessage() != nil:
		return msg.GetSplitPaymentMessage().GetContextInfo()
	case msg.GetMessageHistoryBundle() != nil:
		return msg.GetMessageHistoryBundle().GetContextInfo()
	case msg.GetMessageHistoryNotice() != nil:
		return msg.GetMessageHistoryNotice().GetContextInfo()
	case msg.GetRichResponseMessage() != nil:
		return msg.GetRichResponseMessage().GetContextInfo()
	case msg.GetCall() != nil:
		return msg.GetCall().GetContextInfo()
	// The wrappers below carry no ContextInfo of their own — the reply lives on
	// the message they nest.
	case msg.GetSendPaymentMessage() != nil:
		return messageContextInfoDepth(msg.GetSendPaymentMessage().GetNoteMessage(), depth+1)
	case msg.GetRequestPaymentMessage() != nil:
		return messageContextInfoDepth(msg.GetRequestPaymentMessage().GetNoteMessage(), depth+1)
	case msg.GetCommentMessage() != nil:
		return messageContextInfoDepth(msg.GetCommentMessage().GetMessage(), depth+1)
	case msg.GetPollCreationMessageV4() != nil:
		return messageContextInfoDepth(msg.GetPollCreationMessageV4().GetMessage(), depth+1)
	}
	return nil
}

// mentionedExtIDs canonicalizes ContextInfo.MentionedJID into actor external ids
// so a mention joins against actors.source_ext_id (rich-media-spec §2). Returns
// nil when nobody was mentioned.
func mentionedExtIDs(c *canonicalizer, ci *waE2E.ContextInfo) []string {
	raw := ci.GetMentionedJID()
	if len(raw) == 0 {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		// ParseJID accepts a bare server-only string without erroring, so an entry
		// with no user part is junk, not a person.
		j, err := types.ParseJID(s)
		if err != nil || j.User == "" {
			continue
		}
		if id := jidString(c.canonicalJID(j)); id != "" {
			out = append(out, id)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// urlPattern matches an EXPLICIT http/https URL inside message text. A bare
// "example.com" is deliberately not matched: giving it a scheme would be a guess,
// and the link scraper (v3-spec §3) would then make an outbound request against
// that guess.
var urlPattern = regexp.MustCompile(`https?://[^\s<>"']+`)

// trailingPunctuation are the characters a URL at the end of a sentence picks up
// but never owns.
const trailingPunctuation = `.,;:!?'"`

// firstURL returns the first http/https URL in s, or "". A closing bracket is
// only stripped when the URL has no opening one, so "(see https://x/a)" loses its
// paren while a Wikipedia "…/Foo_(bar)" keeps it.
func firstURL(s string) string {
	u := strings.TrimRight(urlPattern.FindString(s), trailingPunctuation)
	for _, pair := range []struct{ opener, closer byte }{{'(', ')'}, {'[', ']'}} {
		for len(u) > 0 && u[len(u)-1] == pair.closer && !strings.ContainsRune(u, rune(pair.opener)) {
			u = strings.TrimRight(u[:len(u)-1], trailingPunctuation)
		}
	}
	return u
}

// messageLink reads the URL a message carries (v3-spec §3). An
// ExtendedTextMessage carries a real preview: MatchedText IS the canonical URL on
// whatsmeow v0.0.0-20260622185415 — there is no CanonicalURL field on this type —
// alongside the title, description and the raw preview thumbnail. Every other
// shape (a plain Conversation, a media caption) carries no preview at all, so the
// URL is recovered from the text itself and the Link is URL-only. Returns nil when
// the message carries no URL.
func (e *Engine) messageLink(chatJID, msgID string, msg *waE2E.Message) *protocol.Link {
	msg = unwrapMessage(msg)
	if msg == nil {
		return nil
	}
	if et := msg.GetExtendedTextMessage(); et != nil {
		if url := et.GetMatchedText(); url != "" {
			return &protocol.Link{
				URL:         url,
				Title:       et.GetTitle(),
				Description: et.GetDescription(),
				ThumbPath:   e.linkThumbnail(chatJID, msgID, et.GetJPEGThumbnail()),
				PreviewType: previewTypeName(et.GetPreviewType()),
			}
		}
	}
	if url := firstURL(plainText(msg)); url != "" {
		return &protocol.Link{URL: url}
	}
	return nil
}

// previewTypeName renders ExtendedTextMessage.PreviewType as a lowercase wire
// value. NONE is the enum's zero value and says nothing, so it renders empty and
// the field is omitted.
func previewTypeName(p waE2E.ExtendedTextMessage_PreviewType) string {
	if p == waE2E.ExtendedTextMessage_NONE {
		return ""
	}
	return strings.ToLower(p.String())
}

// linkThumbnail persists a link preview's JPEGThumbnail under the media dir and
// returns its path. A preview has no downloadable media behind it — the picture
// IS those bytes — so this is the thumbnail-only write applied to a payload that
// never had a full file. The ".link" suffix keeps it clear of the media file's own
// thumbnail for a message that carries both.
func (e *Engine) linkThumbnail(chatJID, msgID string, thumb []byte) string {
	if len(thumb) == 0 {
		return ""
	}
	dir := filepathJoin(e.mediaDir, safePathSegment(chatJID))
	if err := mkdirAll(dir); err != nil {
		e.logf("link thumbnail dir failed for %s: %v", dir, err)
		return ""
	}
	return e.writeThumbnail(dir, safePathSegment(msgID)+".link", thumb)
}

// canonicalChatJID canonicalizes the chat JID for a message. For DMs it uses
// the per-message RecipientAlt hint (the peer's other address) before falling
// back to the LID store; groups are returned device-stripped as-is.
func (e *Engine) canonicalChatJID(c *canonicalizer, info types.MessageInfo) types.JID {
	if info.IsGroup || chatKind(info.Chat) == "group" {
		return c.canonicalJID(info.Chat)
	}
	return e.canonicalUserJID(c, info.Chat, info.RecipientAlt)
}

// canonicalUserJID canonicalizes a user JID, trying the per-message alt hint
// first. If `primary` is a LID and `alt` is its PN, we use `alt` directly
// (no store round-trip); otherwise we defer to the canonicalizer (self-chat
// collapse + LID store).
func (e *Engine) canonicalUserJID(c *canonicalizer, primary, alt types.JID) types.JID {
	if primary.Server == types.HiddenUserServer && !alt.IsEmpty() && alt.Server == types.DefaultUserServer {
		// Opportunistically persist the mapping so future lookups (and other
		// chats) resolve without the alt hint. READ-ONLY: this only writes to
		// the local session store, never to WhatsApp.
		if e.client != nil {
			e.client.StoreLIDPNMapping(context.Background(), primary.ToNonAD(), alt.ToNonAD())
		}
		return c.canonicalJID(alt)
	}
	return c.canonicalJID(primary)
}

// jidString renders a JID to its wire string, empty for the empty JID.
func jidString(j types.JID) string {
	if j.IsEmpty() {
		return ""
	}
	return j.String()
}

// fallbackLabel is the last-resort display label for a JID when no real name is
// known: the phone number (with +) for PN JIDs, else the bare user/JID. The UI
// may pretty-print further.
func fallbackLabel(j types.JID) string {
	if j.IsEmpty() {
		return ""
	}
	if j.Server == types.GroupServer || j.Server == types.BroadcastServer {
		return j.User
	}
	if h := handleFromJID(j); h != "" {
		return h
	}
	return j.User
}

// downloadable describes a media payload we can download. meta carries the
// proto-side descriptor fields (dimensions, duration, caption, flags);
// downloadMedia fills in the rest once the bytes are on disk.
type downloadable struct {
	msg      whatsmeow.DownloadableMessage
	mime     string
	filename string
	ext      string
	thumb    []byte // JPEGThumbnail, written alongside the file
	meta     protocol.Media
}

func imageDownloadable(im *waE2E.ImageMessage) *downloadable {
	return &downloadable{
		msg:  im,
		mime: im.GetMimetype(),
		ext:  extFor(im.GetMimetype(), "jpg"),
		meta: protocol.Media{
			Width:   int(im.GetWidth()),
			Height:  int(im.GetHeight()),
			Caption: im.GetCaption(),
		},
	}
}

// videoDownloadable also covers PtvMessage (round video notes), which is a
// VideoMessage in the proto. The JPEGThumbnail is kept because a video's own
// bytes are not readable without ffmpeg.
func videoDownloadable(vm *waE2E.VideoMessage) *downloadable {
	return &downloadable{
		msg:   vm,
		mime:  vm.GetMimetype(),
		ext:   extFor(vm.GetMimetype(), "mp4"),
		thumb: vm.GetJPEGThumbnail(),
		meta: protocol.Media{
			Width:    int(vm.GetWidth()),
			Height:   int(vm.GetHeight()),
			Seconds:  int(vm.GetSeconds()),
			Caption:  vm.GetCaption(),
			Animated: vm.GetGifPlayback(),
		},
	}
}

func audioDownloadable(am *waE2E.AudioMessage) *downloadable {
	return &downloadable{
		msg:  am,
		mime: am.GetMimetype(),
		ext:  extFor(am.GetMimetype(), "ogg"),
		meta: protocol.Media{
			Seconds: int(am.GetSeconds()),
			Voice:   am.GetPTT(),
		},
	}
}

func documentDownloadable(dm *waE2E.DocumentMessage) *downloadable {
	return &downloadable{
		msg:      dm,
		mime:     dm.GetMimetype(),
		filename: dm.GetFileName(),
		ext:      extFromName(dm.GetFileName(), extFor(dm.GetMimetype(), "bin")),
		thumb:    dm.GetJPEGThumbnail(),
		meta: protocol.Media{
			Pages:   int(dm.GetPageCount()),
			Caption: dm.GetCaption(),
		},
	}
}

// thumbnailDownloadable describes a payload whose ONLY bytes are a raw
// JPEGThumbnail with no downloadable media behind it — an order card, an
// interactive header, a click-to-WhatsApp ad reply (v3-spec §5). `msg` stays nil,
// which is what tells downloadMedia to skip the download entirely. Returns nil
// when there are no bytes, so callers can chain it like the other extractors.
func thumbnailDownloadable(thumb []byte, caption string) *downloadable {
	if len(thumb) == 0 {
		return nil
	}
	return &downloadable{
		mime:  "image/jpeg",
		ext:   "jpg",
		thumb: thumb,
		meta:  protocol.Media{Caption: caption},
	}
}

func stickerDownloadable(sm *waE2E.StickerMessage) *downloadable {
	return &downloadable{
		msg:  sm,
		mime: sm.GetMimetype(),
		ext:  extFor(sm.GetMimetype(), "webp"),
		meta: protocol.Media{
			Width:    int(sm.GetWidth()),
			Height:   int(sm.GetHeight()),
			Animated: sm.GetIsAnimated(),
		},
	}
}

// unwrapMessage recursively unwraps CONTAINER message types until it reaches the
// real payload (contract §R6.2). Many real messages — including business ones —
// arrive wrapped in Ephemeral/ViewOnce/DeviceSent/DocumentWithCaption/Edited/
// FutureProof containers; the classifier that only looks at the top level then
// sees an empty message and falls through to a placeholder. We peel every known
// wrapper before classifying so the inner Conversation/ExtendedText/media/
// business content is seen.
//
// A depth cap prevents pathological/looping proto from spinning forever.
func unwrapMessage(msg *waE2E.Message) *waE2E.Message {
	for i := 0; i < maxUnwrapDepth && msg != nil; i++ {
		inner, wrapped := unwrapContainer(msg)
		if !wrapped {
			return msg
		}
		msg = inner
	}
	return msg
}

// maxUnwrapDepth bounds every walk over the container chain.
const maxUnwrapDepth = 8

// unwrapContainer peels ONE container layer, returning the nested payload and
// whether msg was a container at all (a container with an empty body yields
// nil, true).
//
// All container accessors are verified against whatsmeow v0.0.0-20260622185415:
//   - EphemeralMessage/ViewOnceMessage/ViewOnceMessageV2/V2Extension/
//     DocumentWithCaptionMessage/EditedMessage return *FutureProofMessage
//     (unwrapped via .GetMessage()).
//   - DeviceSentMessage.GetMessage() returns the inner *Message.
//   - ProtocolMessage with an EditedMessage (MESSAGE_EDIT) carries the new
//     content in ProtocolMessage.GetEditedMessage().
func unwrapContainer(msg *waE2E.Message) (*waE2E.Message, bool) {
	switch {
	case msg.GetEphemeralMessage() != nil:
		return msg.GetEphemeralMessage().GetMessage(), true
	case msg.GetViewOnceMessage() != nil:
		return msg.GetViewOnceMessage().GetMessage(), true
	case msg.GetViewOnceMessageV2() != nil:
		return msg.GetViewOnceMessageV2().GetMessage(), true
	case msg.GetViewOnceMessageV2Extension() != nil:
		return msg.GetViewOnceMessageV2Extension().GetMessage(), true
	case msg.GetDeviceSentMessage() != nil:
		return msg.GetDeviceSentMessage().GetMessage(), true
	case msg.GetDocumentWithCaptionMessage() != nil:
		return msg.GetDocumentWithCaptionMessage().GetMessage(), true
	case msg.GetEditedMessage() != nil:
		return msg.GetEditedMessage().GetMessage(), true
	case msg.GetAssociatedChildMessage() != nil:
		// Album items / thread children arrive wrapped as an associated child
		// (wa-diag.log: unhandled field=AssociatedChildMessage); peel to the
		// real inner payload (an image/text) so it ingests instead of dropping.
		return msg.GetAssociatedChildMessage().GetMessage(), true
	case isMessageEdit(msg):
		// A ProtocolMessage of type MESSAGE_EDIT carries the replacement body in
		// EditedMessage; unwrap to that so the edited text ingests (not a
		// contentless system event). REVOKE/other protocol types are left alone
		// (handled by classify's revoke/system paths).
		return msg.GetProtocolMessage().GetEditedMessage(), true
	}
	return nil, false
}

// protocolTarget returns the ProtocolMessage buried in the container chain, or
// nil. unwrapMessage peels straight past it to the replacement body, so an
// edit's / revoke's target key has to be collected before that.
func protocolTarget(msg *waE2E.Message) *waE2E.ProtocolMessage {
	for i := 0; i < maxUnwrapDepth && msg != nil; i++ {
		if pm := msg.GetProtocolMessage(); pm != nil {
			return pm
		}
		inner, wrapped := unwrapContainer(msg)
		if !wrapped {
			return nil
		}
		msg = inner
	}
	return nil
}

// editRevokeTarget reports whether msg replaces (edits) or deletes (revokes) an
// earlier message named by pm.Key, so the worker can fold it into that row
// (rich-media-spec §2/§5). A ProtocolMessage with no key targets nothing, which
// is what keeps ordinary protocol traffic (history-sync, key-share) out.
//
// The type is read off the FIELD rather than GetType(): REVOKE is the zero value
// of ProtocolMessage_Type, so a getter can't tell a real revoke from an absent
// type. `edit` — the stanza-level attribute whatsmeow parses onto MessageInfo —
// is the fallback for exactly that case.
func editRevokeTarget(pm *waE2E.ProtocolMessage, edit types.EditAttribute) (edits, revokes bool) {
	if pm.GetKey().GetID() == "" {
		return false, false
	}
	if pm.Type != nil {
		switch pm.GetType() {
		case waE2E.ProtocolMessage_MESSAGE_EDIT:
			return true, false
		case waE2E.ProtocolMessage_REVOKE:
			return false, true
		}
	}
	switch edit {
	case types.EditAttributeMessageEdit:
		return true, false
	case types.EditAttributeSenderRevoke, types.EditAttributeAdminRevoke:
		return false, true
	}
	return false, false
}

// isMessageEdit reports whether msg is a ProtocolMessage carrying an edited
// message body (type MESSAGE_EDIT) — the wrapper form of an edit, distinct from
// the top-level EditedMessage container.
func isMessageEdit(msg *waE2E.Message) bool {
	pm := msg.GetProtocolMessage()
	return pm != nil && pm.GetType() == waE2E.ProtocolMessage_MESSAGE_EDIT && pm.GetEditedMessage() != nil
}

// plainText extracts the PLAIN, user-visible text of a message BEFORE any
// business/placeholder path (contract §R6.2): a Conversation, an ExtendedText
// body, or a media caption. Returns "" when the message carries no such plain
// text. This guarantees a business account that simply sends plain text (most
// OTPs) is never reduced to a "[business message]" placeholder.
func plainText(msg *waE2E.Message) string {
	switch {
	case msg.GetConversation() != "":
		return msg.GetConversation()
	case msg.GetExtendedTextMessage() != nil:
		return msg.GetExtendedTextMessage().GetText()
	case msg.GetImageMessage() != nil:
		return msg.GetImageMessage().GetCaption()
	case msg.GetVideoMessage() != nil:
		return msg.GetVideoMessage().GetCaption()
	case msg.GetDocumentMessage() != nil:
		return msg.GetDocumentMessage().GetCaption()
	}
	return ""
}

// classify determines the event kind, text, and any downloadable media. It
// unwraps container messages recursively FIRST (contract §R6.2) so wrapped
// payloads are seen, then extracts plain text before any business/placeholder
// path.
func classify(msg *waE2E.Message) (protocol.Kind, string, *downloadable) {
	msg = unwrapMessage(msg)
	if msg == nil {
		return protocol.KindSystem, "", nil
	}
	switch {
	case msg.GetConversation() != "":
		return protocol.KindMessage, msg.GetConversation(), nil
	case msg.GetExtendedTextMessage() != nil:
		return protocol.KindMessage, msg.GetExtendedTextMessage().GetText(), nil
	case msg.GetImageMessage() != nil:
		im := msg.GetImageMessage()
		return protocol.KindImage, im.GetCaption(), imageDownloadable(im)
	case msg.GetVideoMessage() != nil:
		vm := msg.GetVideoMessage()
		return protocol.KindVideo, vm.GetCaption(), videoDownloadable(vm)
	case msg.GetPtvMessage() != nil:
		// A round video note: the same VideoMessage proto on a different field.
		pv := msg.GetPtvMessage()
		return protocol.KindVideo, pv.GetCaption(), videoDownloadable(pv)
	case msg.GetAudioMessage() != nil:
		am := msg.GetAudioMessage()
		return protocol.KindAudio, "", audioDownloadable(am)
	case msg.GetDocumentMessage() != nil:
		dm := msg.GetDocumentMessage()
		return protocol.KindDocument, dm.GetCaption(), documentDownloadable(dm)
	case msg.GetStickerMessage() != nil:
		sm := msg.GetStickerMessage()
		return protocol.KindSticker, "", stickerDownloadable(sm)
	case msg.GetLocationMessage() != nil:
		lm := msg.GetLocationMessage()
		text := fmt.Sprintf("%f,%f", lm.GetDegreesLatitude(), lm.GetDegreesLongitude())
		if n := lm.GetName(); n != "" {
			text = n + " (" + text + ")"
		}
		return protocol.KindLocation, text, nil
	case msg.GetLiveLocationMessage() != nil:
		llm := msg.GetLiveLocationMessage()
		text := fmt.Sprintf("%f,%f", llm.GetDegreesLatitude(), llm.GetDegreesLongitude())
		if caption := llm.GetCaption(); caption != "" {
			text = caption + " (" + text + ")"
		}
		return protocol.KindLiveLocation, text, nil
	case msg.GetContactMessage() != nil:
		return protocol.KindContact, msg.GetContactMessage().GetDisplayName(), nil
	case msg.GetContactsArrayMessage() != nil:
		return protocol.KindContact, contactsArrayText(msg.GetContactsArrayMessage()), nil
	case msg.GetReactionMessage() != nil:
		return protocol.KindReaction, msg.GetReactionMessage().GetText(), nil
	case msg.GetEncReactionMessage() != nil:
		// A community/encrypted reaction: the emoji is inside EncPayload, which we
		// have no key for. The target id is still readable, so emit the reaction
		// and let the worker treat the empty text as a removal.
		return protocol.KindReaction, "", nil
	case pollText(msg) != "":
		// Polls are user content the plain mapper used to DROP (they fell through
		// to the system path and vanished). Surface the poll question as text so
		// they ingest instead of vanishing (bug 1: missing messages).
		return protocol.KindPoll, pollText(msg), nil
	case msg.GetPollUpdateMessage() != nil:
		// A vote. Which option was picked lives in an encrypted PollEncValue, so
		// there is no text to surface — only the fact that a vote happened.
		return protocol.KindPollVote, "", nil
	case callText(msg) != "":
		return protocol.KindCall, callText(msg), nil
	case msg.GetAlbumMessage() != nil:
		// An album header announces the photos that follow it and carries nothing
		// else: the proto has only the two expected counts, which WhatsApp leaves
		// unset anyway, so there is no byte of it a person wrote. Grouping is gone
		// (v7-spec §1) and the photos ingest as ordinary messages of their own, so
		// the header now has nothing left to mark — kind system with no text takes
		// it out through mapMessage's contentless-system drop. Any placeholder here
		// would be a row the user never sent, sitting above photos that already
		// speak for themselves.
		return protocol.KindSystem, "", nil
	case isRevoke(msg):
		return protocol.KindRevoked, "", nil
	case msg.GetProtocolMessage() != nil:
		return protocol.KindSystem, "", nil
	}

	// Business / non-plain message types (contract §R4.2, bug 16). WhatsApp
	// Business accounts frequently send templates, lists, buttons, interactive,
	// product, and order messages (plus their reply variants). The plain mapper
	// dropped these -> business chats showed "No messages". Extract a sensible
	// display text so they ingest.
	if text := businessText(msg); text != "" {
		// The header of a template/interactive/product card carries the picture the
		// user actually sees; rendering only the body turned WhatsApp's own
		// announcement card into a text-only row.
		if kind, dl := businessHeaderMedia(msg); dl != nil {
			return kind, text, dl
		}
		return protocol.KindMessage, text, nil
	}

	// DIAGNOSTIC (contract §R6.2): we reached here with a non-nil message that
	// carries no extractable text and isn't a known media/business/system type.
	// Log the concrete populated proto field name(s) to STDERR (never stdout /
	// protocol) so the next round can add a targeted extractor. classifyDiag is
	// reflection-based and cheap; it only runs on this cold, unhandled path.
	if name := populatedMessageField(msg); name != "" {
		fmt.Fprintf(os.Stderr, "[wa] classify: no text extracted; unhandled waE2E.Message field=%s\n", name)
	}

	return protocol.KindSystem, "", nil
}

// populatedMessageField reports the name(s) of the non-nil/non-zero fields on a
// waE2E.Message via reflection, for the classify diagnostic (contract §R6.2). It
// skips the message-secret/context metadata fields that are always present and
// carry no user content, so the log points at the actual unhandled payload. It
// is intentionally allocation-light and only invoked on the unhandled path.
func populatedMessageField(msg *waE2E.Message) string {
	if msg == nil {
		return ""
	}
	v := reflect.ValueOf(msg).Elem()
	t := v.Type()
	var names []string
	for i := 0; i < v.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue // skip protoimpl state/sizeCache/unknownFields
		}
		switch f.Name {
		case "MessageContextInfo":
			continue // metadata, not a payload type
		}
		fv := v.Field(i)
		switch fv.Kind() {
		case reflect.Ptr, reflect.Slice, reflect.Map, reflect.Interface:
			if !fv.IsNil() {
				names = append(names, f.Name)
			}
		}
	}
	return strings.Join(names, ",")
}

// businessText extracts REAL display text from business/non-plain message types
// exposed by whatsmeow v0.0.0-20260622185415 (contract §R5.2, bug 2). Returns ""
// when the message is not one of these types (so the caller falls through to the
// system path). Accessor names verified against the installed proto (waE2E).
//
// Contract guarantee: no event may surface a bare "[template message]". We dig
// through the hydrated body/title/footer AND the non-hydrated FourRowTemplate
// content before ever using a placeholder, and the placeholder we do use as a
// genuine last resort is a short human label ("[business message]"), never the
// literal "[template message]" that the UI flagged.
func businessText(msg *waE2E.Message) string {
	if tm := msg.GetTemplateMessage(); tm != nil {
		if t := templateText(tm); t != "" {
			return t
		}
		return businessPlaceholderFor("TemplateMessage", tm)
	}
	if lm := msg.GetListMessage(); lm != nil {
		// Also the CTA button label and the section/row titles a list carries.
		if t := firstNonEmpty(lm.GetDescription(), lm.GetTitle(), lm.GetFooterText(), lm.GetButtonText()); t != "" {
			return t
		}
		for _, s := range lm.GetSections() {
			if s.GetTitle() != "" {
				return s.GetTitle()
			}
			for _, row := range s.GetRows() {
				if t := firstNonEmpty(row.GetTitle(), row.GetDescription()); t != "" {
					return t
				}
			}
		}
		return businessPlaceholderFor("ListMessage", lm)
	}
	if bm := msg.GetButtonsMessage(); bm != nil {
		if t := firstNonEmpty(bm.GetContentText(), bm.GetText(), bm.GetFooterText()); t != "" {
			return t
		}
		for _, b := range bm.GetButtons() {
			if t := b.GetButtonText().GetDisplayText(); t != "" {
				return t
			}
		}
		return businessPlaceholderFor("ButtonsMessage", bm)
	}
	if im := msg.GetInteractiveMessage(); im != nil {
		if t := interactiveText(im); t != "" {
			return t
		}
		return businessPlaceholderFor("InteractiveMessage", im)
	}
	if pm := msg.GetProductMessage(); pm != nil {
		if b := pm.GetBody(); b != "" {
			return b
		}
		if snap := pm.GetProduct(); snap != nil {
			if t := firstNonEmpty(snap.GetTitle(), snap.GetDescription()); t != "" {
				return t
			}
		}
		return businessPlaceholderFor("ProductMessage", pm)
	}
	if om := msg.GetOrderMessage(); om != nil {
		if t := firstNonEmpty(om.GetMessage(), om.GetOrderTitle()); t != "" {
			return t
		}
		return businessPlaceholderFor("OrderMessage", om)
	}
	// Payment note / comment carry a NESTED *Message; extract its plain text.
	if pay := msg.GetSendPaymentMessage(); pay != nil {
		if t := nestedMessageText(pay.GetNoteMessage()); t != "" {
			return t
		}
		return businessPlaceholderFor("SendPaymentMessage", pay)
	}
	if pay := msg.GetRequestPaymentMessage(); pay != nil {
		if t := nestedMessageText(pay.GetNoteMessage()); t != "" {
			return t
		}
		return businessPlaceholderFor("RequestPaymentMessage", pay)
	}
	if cm := msg.GetCommentMessage(); cm != nil {
		if t := nestedMessageText(cm.GetMessage()); t != "" {
			return t
		}
		return businessPlaceholderFor("CommentMessage", cm)
	}
	// Reply variants (a customer/user tapping a template/list/button/interactive).
	// Use explicit returns rather than a single fallback expression so the
	// diagnostic placeholder is only evaluated — and only logged — when the text is
	// genuinely empty.
	if r := msg.GetTemplateButtonReplyMessage(); r != nil {
		if t := r.GetSelectedDisplayText(); t != "" {
			return t
		}
		return businessPlaceholderFor("TemplateButtonReplyMessage", r)
	}
	if r := msg.GetListResponseMessage(); r != nil {
		if t := firstNonEmpty(r.GetTitle(), r.GetDescription()); t != "" {
			return t
		}
		return businessPlaceholderFor("ListResponseMessage", r)
	}
	if r := msg.GetButtonsResponseMessage(); r != nil {
		if t := r.GetSelectedDisplayText(); t != "" {
			return t
		}
		return businessPlaceholderFor("ButtonsResponseMessage", r)
	}
	if r := msg.GetInteractiveResponseMessage(); r != nil {
		if b := r.GetBody(); b != nil && b.GetText() != "" {
			return b.GetText()
		}
		if nf := r.GetNativeFlowResponseMessage(); nf != nil && nf.GetName() != "" {
			return nf.GetName()
		}
		return businessPlaceholderFor("InteractiveResponseMessage", r)
	}
	// A top-level HighlyStructuredMessage (some business templates arrive this way
	// rather than wrapped in a TemplateMessage).
	if hsm := msg.GetHighlyStructuredMessage(); hsm != nil {
		if t := structuredText(hsm); t != "" {
			return t
		}
		return businessPlaceholderFor("HighlyStructuredMessage", hsm)
	}
	// Group-invite card ("Join my group"): show its caption / group name so the
	// chat isn't empty.
	if gi := msg.GetGroupInviteMessage(); gi != nil {
		if t := firstNonEmpty(gi.GetCaption(), gi.GetGroupName()); t != "" {
			return t
		}
		return businessPlaceholderFor("GroupInviteMessage", gi)
	}
	// Event message (WhatsApp Events): its name/description is the display text.
	if em := msg.GetEventMessage(); em != nil {
		if t := firstNonEmpty(em.GetName(), em.GetDescription()); t != "" {
			return t
		}
		return businessPlaceholderFor("EventMessage", em)
	}
	return ""
}

// businessHeaderMedia returns the media a business card carries in its header
// (template title, interactive header, carousel card, product/catalog image, order
// thumbnail) with the kind that media implies, or ("", nil) when there is none.
// businessText renders only the body, so without this the picture on an
// announcement card is lost.
func businessHeaderMedia(msg *waE2E.Message) (protocol.Kind, *downloadable) {
	if kind, dl := templateHeaderMedia(msg.GetTemplateMessage(), 0); dl != nil {
		return kind, dl
	}
	// A top-level HighlyStructuredMessage nests its rendered card in HydratedHsm.
	// structuredText already recurses in for the text; the picture on the same card
	// was left behind (v3-spec §5).
	if hsm := msg.GetHighlyStructuredMessage(); hsm != nil {
		if kind, dl := templateHeaderMedia(hsm.GetHydratedHsm(), 0); dl != nil {
			return kind, dl
		}
	}
	if kind, dl := interactiveHeaderMedia(msg.GetInteractiveMessage(), 0); dl != nil {
		return kind, dl
	}
	if kind, dl := productMedia(msg.GetProductMessage()); dl != nil {
		return kind, dl
	}
	if om := msg.GetOrderMessage(); om != nil {
		// An order card ships its picture as raw bytes only — there is no full media
		// to download behind it.
		if dl := thumbnailDownloadable(om.GetThumbnail(), firstNonEmpty(om.GetOrderTitle(), om.GetMessage())); dl != nil {
			return protocol.KindImage, dl
		}
	}
	return "", nil
}

// templateHeaderMedia picks the media off a TemplateMessage's header, in the same
// order templateText reads its text: the hydrated four-row template (either
// accessor), then the non-hydrated one, then the interactive template it may wrap.
// It recurses through a four-row template's HighlyStructuredMessages because those
// nest a whole rendered TemplateMessage in HydratedHsm — the shape modern business
// OTP/announcement cards actually arrive in. Depth-bounded like templateText, for
// the same reason.
func templateHeaderMedia(tm *waE2E.TemplateMessage, depth int) (protocol.Kind, *downloadable) {
	if tm == nil || depth > maxBusinessDepth {
		return "", nil
	}
	h := tm.GetHydratedTemplate()
	if h == nil {
		h = tm.GetHydratedFourRowTemplate()
	}
	if kind, dl := headerMedia(h.GetImageMessage(), h.GetVideoMessage(), h.GetDocumentMessage()); dl != nil {
		return kind, dl
	}
	if frt := tm.GetFourRowTemplate(); frt != nil {
		if kind, dl := headerMedia(frt.GetImageMessage(), frt.GetVideoMessage(), frt.GetDocumentMessage()); dl != nil {
			return kind, dl
		}
		for _, hsm := range []*waE2E.HighlyStructuredMessage{frt.GetContent(), frt.GetHighlyStructuredMessage(), frt.GetFooter()} {
			if kind, dl := templateHeaderMedia(hsm.GetHydratedHsm(), depth+1); dl != nil {
				return kind, dl
			}
		}
	}
	return interactiveHeaderMedia(tm.GetInteractiveMessageTemplate(), depth)
}

// interactiveHeaderMedia picks the media off an InteractiveMessage: the header's
// image/video/document, the product card a header can hold instead, the header's
// own raw thumbnail, and finally each carousel card — a carousel keeps its
// pictures on the cards, never on the message, so a carousel's header media is
// unreachable without descending. Cards are themselves InteractiveMessages, hence
// the depth bound.
func interactiveHeaderMedia(im *waE2E.InteractiveMessage, depth int) (protocol.Kind, *downloadable) {
	if im == nil || depth > maxBusinessDepth {
		return "", nil
	}
	h := im.GetHeader()
	if kind, dl := headerMedia(h.GetImageMessage(), h.GetVideoMessage(), h.GetDocumentMessage()); dl != nil {
		return kind, dl
	}
	if kind, dl := productMedia(h.GetProductMessage()); dl != nil {
		return kind, dl
	}
	if dl := thumbnailDownloadable(h.GetJPEGThumbnail(), firstNonEmpty(h.GetTitle(), h.GetSubtitle())); dl != nil {
		return protocol.KindImage, dl
	}
	for _, card := range im.GetCarouselMessage().GetCards() {
		if kind, dl := interactiveHeaderMedia(card, depth+1); dl != nil {
			return kind, dl
		}
	}
	return "", nil
}

// productMedia picks a product card's picture: the product's own image, else the
// catalog cover it was offered from.
func productMedia(pm *waE2E.ProductMessage) (protocol.Kind, *downloadable) {
	if img := pm.GetProduct().GetProductImage(); img != nil {
		return protocol.KindImage, imageDownloadable(img)
	}
	if img := pm.GetCatalog().GetCatalogImage(); img != nil {
		return protocol.KindImage, imageDownloadable(img)
	}
	return "", nil
}

// externalAdReplyMedia is the picture on the click-to-WhatsApp ad card a business
// conversation opens with (v3-spec §5). It carries raw thumbnail bytes only, and
// its title/body describe what was advertised, so both are kept as the media's
// caption. Returns nil when the context carries no ad card or no thumbnail.
func externalAdReplyMedia(ci *waE2E.ContextInfo) *downloadable {
	ad := ci.GetExternalAdReply()
	if ad == nil {
		return nil
	}
	caption := strings.TrimSpace(ad.GetTitle() + "\n" + ad.GetBody())
	return thumbnailDownloadable(ad.GetThumbnail(), caption)
}

// headerMedia picks the first populated header attachment. The three carriers
// (hydrated template title, four-row template title, interactive header) all
// expose the same image/video/document oneof.
func headerMedia(img *waE2E.ImageMessage, vid *waE2E.VideoMessage, doc *waE2E.DocumentMessage) (protocol.Kind, *downloadable) {
	switch {
	case img != nil:
		return protocol.KindImage, imageDownloadable(img)
	case vid != nil:
		return protocol.KindVideo, videoDownloadable(vid)
	case doc != nil:
		return protocol.KindDocument, documentDownloadable(doc)
	}
	return "", nil
}

// interactiveText extracts the display text of an InteractiveMessage: body →
// header title/subtitle → footer → the same on each carousel card, since a
// carousel carries all of its content on the cards and would otherwise be reduced
// to the placeholder. Returns "" when nothing carries text.
func interactiveText(im *waE2E.InteractiveMessage) string {
	return interactiveTextDepth(im, 0)
}

func interactiveTextDepth(im *waE2E.InteractiveMessage, depth int) string {
	if im == nil || depth > maxBusinessDepth {
		return ""
	}
	if b := im.GetBody(); b != nil && b.GetText() != "" {
		return b.GetText()
	}
	if h := im.GetHeader(); h != nil {
		if t := firstNonEmpty(h.GetTitle(), h.GetSubtitle()); t != "" {
			return t
		}
	}
	if f := im.GetFooter(); f != nil && f.GetText() != "" {
		return f.GetText()
	}
	for _, card := range im.GetCarouselMessage().GetCards() {
		if t := interactiveTextDepth(card, depth+1); t != "" {
			return t
		}
	}
	return ""
}

// nestedMessageText extracts the PLAIN text (Conversation / ExtendedText /
// caption) of a *nested* message carried by a payment-note / comment wrapper. It
// deliberately uses plainText (not classify) so it can't recurse back into
// businessText. Returns "" when the nested message carries no plain text.
func nestedMessageText(m *waE2E.Message) string {
	if m == nil {
		return ""
	}
	return plainText(unwrapMessage(m))
}

// businessPlaceholderFor logs the concrete business message TYPE and the names of
// its populated sub-fields to STDERR (the classify diagnostic, contract §R6.2),
// then returns businessPlaceholder. It fires ONLY on the cold path where a known
// business type carried no extractable text, so the next real-device repro
// pinpoints exactly which sub-field (e.g. HydratedHsm) still needs an extractor.
// STDERR only — never stdout/protocol.
func businessPlaceholderFor(typeName string, sub any) string {
	if fields := populatedFields(sub); fields != "" {
		fmt.Fprintf(os.Stderr, "[wa] businessText: no text extracted; type=%s populated=[%s]\n", typeName, fields)
	} else {
		fmt.Fprintf(os.Stderr, "[wa] businessText: no text extracted; type=%s\n", typeName)
	}
	return businessPlaceholder
}

// populatedFields generalizes populatedMessageField to ANY proto struct pointer:
// the names of its non-nil ptr/slice/map/interface and non-empty string fields
// (skipping ContextInfo metadata). Used only on the cold diagnostic path.
func populatedFields(m any) string {
	v := reflect.ValueOf(m)
	if v.Kind() == reflect.Ptr {
		if v.IsNil() {
			return ""
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return ""
	}
	t := v.Type()
	var names []string
	for i := 0; i < v.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() || f.Name == "ContextInfo" {
			continue
		}
		fv := v.Field(i)
		switch fv.Kind() {
		case reflect.Ptr, reflect.Slice, reflect.Map, reflect.Interface:
			if !fv.IsNil() {
				names = append(names, f.Name)
			}
		case reflect.String:
			if fv.Len() > 0 {
				names = append(names, f.Name)
			}
		}
	}
	return strings.Join(names, ",")
}

// pollText returns a display string for a poll-creation message (any version),
// or "" when msg is not a poll (contract §R6.2 — poll question is user content).
// whatsmeow getters are nil-safe, so an absent version yields "".
func pollText(msg *waE2E.Message) string {
	name := pollName(msg)
	if name == "" {
		return ""
	}
	return "📊 " + name
}

// pollName returns a poll's question across every version of the proto. V4 is
// the odd one out: it nests its PollCreationMessage in a FutureProofMessage
// instead of carrying it directly, so the wrapped message is checked too.
func pollName(msg *waE2E.Message) string {
	for i := 0; i < 2 && msg != nil; i++ {
		if name := firstNonEmpty(
			msg.GetPollCreationMessage().GetName(),
			msg.GetPollCreationMessageV2().GetName(),
			msg.GetPollCreationMessageV3().GetName(),
			msg.GetPollCreationMessageV5().GetName(),
			msg.GetPollCreationMessageV6().GetName(),
		); name != "" {
			return name
		}
		msg = msg.GetPollCreationMessageV4().GetMessage()
	}
	return ""
}

// callText renders a call event — a finished call's log line or a scheduled
// call's title — or "" when msg is not a call.
func callText(msg *waE2E.Message) string {
	if cl := msg.GetCallLogMesssage(); cl != nil {
		label := "Voice call"
		if cl.GetIsVideo() {
			label = "Video call"
		}
		detail := strings.ToLower(strings.ReplaceAll(cl.GetCallOutcome().String(), "_", " "))
		if secs := cl.GetDurationSecs(); secs > 0 {
			detail = fmt.Sprintf("%s, %ds", detail, secs)
		}
		return "📞 " + label + " (" + detail + ")"
	}
	if sc := msg.GetScheduledCallCreationMessage(); sc != nil {
		if title := sc.GetTitle(); title != "" {
			return "📞 Scheduled call: " + title
		}
		return "📞 Scheduled call"
	}
	return ""
}

// contactsArrayText lists the display names of a shared contact card set, or
// falls back to the array's own label when the entries are nameless.
func contactsArrayText(cam *waE2E.ContactsArrayMessage) string {
	names := make([]string, 0, len(cam.GetContacts()))
	for _, c := range cam.GetContacts() {
		if n := c.GetDisplayName(); n != "" {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return cam.GetDisplayName()
	}
	return strings.Join(names, ", ")
}

// businessPlaceholder is the ONLY placeholder businessText may emit, and only
// when a message genuinely carries no extractable text. It is deliberately NOT
// the literal "[template message]" the UI flagged (contract §R5.2, bug 2).
const businessPlaceholder = "[business message]"

// templateText extracts the real content text from a TemplateMessage, trying the
// hydrated four-row template first (the common case for received business
// templates: HydratedContentText / title / footer), then the non-hydrated
// FourRowTemplate whose Content/Title/Footer are HighlyStructuredMessages.
// Returns "" only when the template truly has no text anywhere.
func templateText(tm *waE2E.TemplateMessage) string {
	return templateTextDepth(tm, 0)
}

// maxBusinessDepth bounds the mutual templateText<->structuredText recursion
// (HydratedHsm nests a TemplateMessage inside a HighlyStructuredMessage) so a
// pathological/cyclic proto can't spin forever.
const maxBusinessDepth = 5

func templateTextDepth(tm *waE2E.TemplateMessage, depth int) string {
	if tm == nil || depth > maxBusinessDepth {
		return ""
	}
	// The hydrated four-row template arrives EITHER as the separate
	// HydratedTemplate field OR via the Format oneof (HydratedFourRowTemplate) —
	// same type, different accessor. Real business/OTP templates (e.g. Jio) set
	// the ONEOF, which GetHydratedTemplate() misses — the dominant surviving
	// "[business message]" cause (wa-diag.log: type=TemplateMessage
	// populated=[Format,TemplateID]).
	h := tm.GetHydratedTemplate()
	if h == nil {
		h = tm.GetHydratedFourRowTemplate()
	}
	if h != nil {
		if t := firstNonEmpty(h.GetHydratedContentText(), h.GetHydratedTitleText(), h.GetHydratedFooterText()); t != "" {
			return t
		}
		// Some templates carry their only text on the buttons (quick-reply / URL /
		// call display text) — common for utility/OTP business templates.
		for _, b := range h.GetHydratedButtons() {
			if t := firstNonEmpty(
				b.GetQuickReplyButton().GetDisplayText(),
				b.GetUrlButton().GetDisplayText(),
				b.GetCallButton().GetDisplayText(),
			); t != "" {
				return t
			}
		}
	}
	if frt := tm.GetFourRowTemplate(); frt != nil {
		if t := firstNonEmpty(
			structuredTextDepth(frt.GetContent(), depth+1),
			structuredTextDepth(frt.GetHighlyStructuredMessage(), depth+1),
			structuredTextDepth(frt.GetFooter(), depth+1),
		); t != "" {
			return t
		}
	}
	// A template that wraps an interactive message.
	if im := tm.GetInteractiveMessageTemplate(); im != nil {
		if t := interactiveText(im); t != "" {
			return t
		}
	}
	return ""
}

// structuredText renders the human text of a HighlyStructuredMessage. These are
// template references (namespace/elementName/params); the readable text is the
// localizable-parameter defaults (preferred) or the raw params, joined with
// spaces. Returns "" when the message is nil or carries no textual params.
func structuredText(hsm *waE2E.HighlyStructuredMessage) string {
	return structuredTextDepth(hsm, 0)
}

func structuredTextDepth(hsm *waE2E.HighlyStructuredMessage, depth int) string {
	if hsm == nil || depth > maxBusinessDepth {
		return ""
	}
	var parts []string
	for _, p := range hsm.GetLocalizableParams() {
		if d := p.GetDefault(); d != "" {
			parts = append(parts, d)
		}
	}
	if len(parts) == 0 {
		for _, p := range hsm.GetParams() {
			if p != "" {
				parts = append(parts, p)
			}
		}
	}
	if t := strings.TrimSpace(strings.Join(parts, " ")); t != "" {
		return t
	}
	// Modern HSM/template OTPs (e.g. Jio) carry the RENDERED text in a nested
	// TemplateMessage (GetHydratedHsm), not in the localizable params — recurse
	// into it so it isn't reduced to "[business message]".
	if inner := hsm.GetHydratedHsm(); inner != nil {
		return templateTextDepth(inner, depth+1)
	}
	return ""
}

// firstNonEmpty returns the first non-empty string among its args, or "".
func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

func isRevoke(msg *waE2E.Message) bool {
	pm := msg.GetProtocolMessage()
	if pm == nil {
		return false
	}
	return pm.GetType() == waE2E.ProtocolMessage_REVOKE
}

// downloadMedia downloads and persists media to
// mediaDir/<chatJID>/<messageID>.<ext>, returning the media descriptor. Both
// path segments are passed through safePathSegment because they come off the
// wire, not from us.
//
// A payload can have no full file at all — several business cards ship a raw
// JPEGThumbnail and nothing else — and a download can fail on one that does. Both
// land in thumbnailOnlyMedia rather than losing the only bytes there were.
func (e *Engine) downloadMedia(chatJID, msgID string, dl *downloadable) (*protocol.Media, error) {
	dir := filepathJoin(e.mediaDir, safePathSegment(chatJID))
	if err := mkdirAll(dir); err != nil {
		return nil, err
	}
	stem := safePathSegment(msgID)

	// A payload with no DownloadableMessage never had a full file (order card,
	// interactive header, ad reply): its thumbnail bytes are the whole media.
	if dl.msg == nil {
		return e.thumbnailOnlyMedia(dir, stem, dl)
	}

	ctx, cancel := context.WithTimeout(e.ctx, 60*time.Second)
	defer cancel()
	data, err := e.client.Download(ctx, dl.msg)
	if err != nil {
		// A failed download used to lose the thumbnail with it, which for a video or
		// a document is the ONLY readable frame there was (v3-spec §5).
		if len(dl.thumb) > 0 {
			e.logf("media download failed for %s/%s (%v); keeping the thumbnail", chatJID, msgID, err)
			return e.thumbnailOnlyMedia(dir, stem, dl)
		}
		return nil, err
	}
	ext := dl.ext
	if ext == "" {
		ext = "bin"
	}
	path := filepathJoin(dir, stem+"."+ext)
	if err := writeFile(path, data); err != nil {
		return nil, err
	}
	filename := dl.filename
	if filename == "" {
		filename = stem + "." + ext
	}
	md := dl.meta
	md.Path = path
	md.Mime = dl.mime
	md.Filename = filename
	md.Size = int64(len(data))
	md.SHA256 = sha256Sum(data)
	md.ThumbPath = e.writeThumbnail(dir, stem, dl.thumb)
	return &md, nil
}

// thumbnailOnlyMedia stores a payload that has nothing but its JPEGThumbnail and
// describes it as the media itself (v3-spec §5). Path POINTS AT THE THUMBNAIL:
// the worker's claimPendingMedia requires media_path IS NOT NULL, and the file is
// a real readable JPEG, so pointing at it needs no predicate change on that side.
// Path == ThumbPath is the signal that there was no full file to begin with.
func (e *Engine) thumbnailOnlyMedia(dir, stem string, dl *downloadable) (*protocol.Media, error) {
	path := e.writeThumbnail(dir, stem, dl.thumb)
	if path == "" {
		return nil, fmt.Errorf("no downloadable media and no thumbnail bytes")
	}
	// Only the caption carries over from the proto descriptor, because it belongs
	// to the MESSAGE. Everything else there described the ORIGINAL file, which is
	// not what is on disk: the dimensions are the video's, not this still's, and
	// the duration is what put media_seconds=14 on a 16 KB JPEG (v4-spec §3). The
	// stored bytes are always a JPEG still, so pages/voice/animated cannot be true
	// of them either.
	md := protocol.Media{
		Path:      path,
		ThumbPath: path,
		Mime:      "image/jpeg",
		Filename:  filepathBase(path),
		Size:      int64(len(dl.thumb)),
		SHA256:    sha256Sum(dl.thumb),
		Caption:   dl.meta.Caption,
	}
	return &md, nil
}

// writeThumbnail persists the proto's JPEGThumbnail next to the media file and
// returns its path. A video (or a PTV, or a document) has no frame we can read
// without shipping ffmpeg, so this thumbnail IS the readable content. Returns ""
// when there is no thumbnail, or when it could not be written — the media itself
// is still usable, so a thumbnail failure never fails the download. `stem` is the
// already-sanitized file stem the media itself was written under.
func (e *Engine) writeThumbnail(dir, stem string, thumb []byte) string {
	if len(thumb) == 0 {
		return ""
	}
	path := filepathJoin(dir, stem+".thumb.jpg")
	if err := writeFile(path, thumb); err != nil {
		e.logf("thumbnail write failed for %s: %v", path, err)
		return ""
	}
	return path
}
