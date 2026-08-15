package wa

import (
	"context"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waVnameCert"
	"go.mau.fi/whatsmeow/types"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// verifiedNameInfo builds a types.MessageInfo carrying a verified business name,
// as whatsmeow surfaces it for a business/OTP sender.
func verifiedNameInfo(t *testing.T, chat types.JID, pushName, verified string) types.MessageInfo {
	t.Helper()
	vn := verified
	return types.MessageInfo{
		ID:       "M1",
		PushName: pushName,
		MessageSource: types.MessageSource{
			Chat:   chat,
			Sender: chat,
		},
		VerifiedName: &types.VerifiedName{
			Details: &waVnameCert.VerifiedNameCertificate_Details{
				VerifiedName: &vn,
			},
		},
	}
}

// TestNamelessBusinessEmitsEmptyName proves STEP 2 / contract §3 (bug: RC1): a DM
// from a sender with NO real name known (no contact, no pushname, no verified
// name) emits an EMPTY Channel.Name / Actor.DisplayName — NOT the phone number —
// while still carrying the number via Handle and the JID via source_ext_id.
func TestNamelessBusinessEmitsEmptyName(t *testing.T) {
	e, _ := newTestEngine() // no client → no contact/verified/pushname resolves
	peer := mustJID(t, "919000012345@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "M1",
		MessageSource: types.MessageSource{Chat: peer, Sender: peer},
	}
	_, ch, ac, ok := e.mapMessage(info, &waE2E.Message{Conversation: strp("Your OTP is 4821")})
	if !ok {
		t.Fatal("real DM must map")
	}
	if ch.Name != "" {
		t.Errorf("channel name = %q, want empty (no real name → empty, not the number)", ch.Name)
	}
	if ac.DisplayName != "" {
		t.Errorf("actor display_name = %q, want empty (no real name → empty, not the number)", ac.DisplayName)
	}
	if ch.SourceExtID != peer.String() || ac.SourceExtID != peer.String() {
		t.Errorf("source_ext_id must carry the JID for frontend pretty-print: ch=%q ac=%q", ch.SourceExtID, ac.SourceExtID)
	}
	if ac.Handle != "+919000012345" {
		t.Errorf("actor handle = %q, want +919000012345 (number carried via Handle)", ac.Handle)
	}
}

// TestVerifiedNameBeatsPushName proves STEP 7 (bug: RC6): for an incoming DM the
// business VERIFIED name is preferred over the transient live PushName.
func TestVerifiedNameBeatsPushName(t *testing.T) {
	e, _ := newTestEngine() // no client → no saved contact
	peer := mustJID(t, "919000067890@s.whatsapp.net")
	info := verifiedNameInfo(t, peer, "Samsung Galaxy", "Acme Bank")

	_, ch, ac, ok := e.mapMessage(info, &waE2E.Message{Conversation: strp("Your statement is ready")})
	if !ok {
		t.Fatal("real DM must map")
	}
	if ch.Name != "Acme Bank" {
		t.Errorf("channel name = %q, want %q (VerifiedName must beat PushName)", ch.Name, "Acme Bank")
	}
	if ac.DisplayName != "Acme Bank" {
		t.Errorf("actor display_name = %q, want %q (VerifiedName must beat PushName)", ac.DisplayName, "Acme Bank")
	}
}

// TestContactNameBeatsVerifiedName proves the priority contract: a SAVED contact
// name (the name the user chose) outranks even the business VerifiedName.
func TestContactNameBeatsVerifiedName(t *testing.T) {
	e, _ := newTestEngine()
	peer := mustJID(t, "919000011111@s.whatsapp.net")
	// Seam: this peer is a saved contact named "My Bank Rep".
	e.contactNameFn = func(j types.JID) string {
		if j.User == "919000011111" {
			return "My Bank Rep"
		}
		return ""
	}
	info := verifiedNameInfo(t, peer, "Samsung Galaxy", "Acme Bank")

	_, ch, ac, ok := e.mapMessage(info, &waE2E.Message{Conversation: strp("hi")})
	if !ok {
		t.Fatal("real DM must map")
	}
	if ch.Name != "My Bank Rep" {
		t.Errorf("channel name = %q, want %q (saved contact must beat VerifiedName)", ch.Name, "My Bank Rep")
	}
	if ac.DisplayName != "My Bank Rep" {
		t.Errorf("actor display_name = %q, want %q (saved contact must beat VerifiedName)", ac.DisplayName, "My Bank Rep")
	}
}

// TestBusinessNameQueriedOnlyOnSuccess proves STEP 4 (bug: RC3) AND the
// load-bearing STEP 1: a JID whose USync call leaves the contact store still
// nameless is NOT recorded in businessNameQueried, so a later sweep RETRIES it; a
// JID whose store BusinessName is populated (by GetUserInfo's updateBusinessName
// side-effect, modeled here) IS recorded so it isn't re-queried. Crucially, the
// name is recovered from the contact store, NOT from the returned
// UserInfo.VerifiedName (which whatsmeow leaves nil).
func TestBusinessNameQueriedOnlyOnSuccess(t *testing.T) {
	e, _ := newTestEngine()
	resolved := mustJID(t, "919000022222@s.whatsapp.net")
	unresolved := mustJID(t, "919000033333@s.whatsapp.net")

	// store models whatsmeow_contacts.business_name: GetUserInfo's updateBusinessName
	// writes into it as a side-effect; contactName reads it back.
	store := map[string]string{}
	e.contactNameFn = func(j types.JID) string { return store[j.User] }

	calls := 0
	// First sweep: the call populates NOTHING (simulates the business profile not yet
	// available server-side). The returned map deliberately carries a nil
	// VerifiedName to prove we never read it.
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		calls++
		out := map[types.JID]types.UserInfo{}
		for _, j := range jids {
			out[j] = types.UserInfo{VerifiedName: nil} // whatsmeow behavior
		}
		return out, nil
	}
	e.resolveUnsavedBusinessNames("test", []types.JID{resolved, unresolved})
	if calls != 1 {
		t.Fatalf("expected 1 lookup call, got %d", calls)
	}
	e.mu.Lock()
	if e.businessNameQueried[resolved.String()] || e.businessNameQueried[unresolved.String()] {
		e.mu.Unlock()
		t.Fatal("no JID should be marked queried when the store is still nameless (must be retryable)")
	}
	e.mu.Unlock()

	// Second sweep: the call now persists a BusinessName for `resolved` into the
	// store (as updateBusinessName would) but leaves `unresolved` nameless. The
	// returned map STILL carries nil VerifiedName — proving the name is read from the
	// store, not the map.
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		calls++
		out := map[types.JID]types.UserInfo{}
		for _, j := range jids {
			if j.User == resolved.User {
				store[j.User] = "Acme Support" // side-effect write, as GetUserInfo does
			}
			out[j] = types.UserInfo{VerifiedName: nil}
		}
		return out, nil
	}
	e.resolveUnsavedBusinessNames("test", []types.JID{resolved, unresolved})

	e.mu.Lock()
	gotResolved := e.businessNameQueried[resolved.String()]
	gotUnresolved := e.businessNameQueried[unresolved.String()]
	e.mu.Unlock()
	if !gotResolved {
		t.Error("a JID whose store BusinessName is now populated must be marked queried")
	}
	if gotUnresolved {
		t.Error("a still-nameless JID must stay un-marked so a later sweep retries it")
	}

	// Third sweep: `resolved` is now skipped (already marked); `unresolved` is
	// still retried. So exactly ONE JID is queried.
	var lastBatch []types.JID
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		lastBatch = jids
		return map[types.JID]types.UserInfo{}, nil
	}
	e.resolveUnsavedBusinessNames("test", []types.JID{resolved, unresolved})
	if len(lastBatch) != 1 || lastBatch[0].User != unresolved.User {
		t.Errorf("third sweep queried %v, want only the still-unresolved %s", lastBatch, unresolved.User)
	}
}

// TestBusinessNameFromStoreNotVerifiedName is the focused STEP 1 (load-bearing)
// proof: a userInfoFn whose returned UserInfo.VerifiedName is nil but whose
// side-effect populates the contact store still yields a Channel{dm}+Actor emit
// carrying the store name; and when the store stays empty, nothing is emitted and
// the JID stays un-queried.
func TestBusinessNameFromStoreNotVerifiedName(t *testing.T) {
	e, buf := newTestEngine()
	biz := mustJID(t, "917204470429@s.whatsapp.net")

	store := map[string]string{}
	e.contactNameFn = func(j types.JID) string { return store[j.User] }

	// Case A: store stays empty -> no emit, JID stays retryable.
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		out := map[types.JID]types.UserInfo{}
		for _, j := range jids {
			out[j] = types.UserInfo{VerifiedName: nil}
		}
		return out, nil
	}
	e.resolveUnsavedBusinessNames("test", []types.JID{biz})
	if got := decodeLines(t, buf); len(got) != 0 {
		t.Fatalf("no name in store must emit nothing, got %d lines: %v", len(got), got)
	}
	e.mu.Lock()
	if e.businessNameQueried[biz.String()] {
		e.mu.Unlock()
		t.Fatal("empty-store JID must stay un-queried (retryable)")
	}
	e.mu.Unlock()

	// Case B: the USync side-effect writes the real name into the store even though
	// VerifiedName is nil -> a Channel{dm}+Actor emit with that name, JID marked.
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		out := map[types.JID]types.UserInfo{}
		for _, j := range jids {
			store[j.User] = "AI-Certifications Portal (PGP)"
			out[j] = types.UserInfo{VerifiedName: nil} // still nil — the whatsmeow bug
		}
		return out, nil
	}
	e.resolveUnsavedBusinessNames("test", []types.JID{biz})

	lines := decodeLines(t, buf)
	var gotChan, gotActor bool
	for _, m := range lines {
		if m["t"] == "channel" {
			c := m["channel"].(map[string]any)
			if c["name"] == "AI-Certifications Portal (PGP)" && c["kind"] == "dm" {
				gotChan = true
			}
		}
		if m["t"] == "actor" {
			a := m["actor"].(map[string]any)
			if a["display_name"] == "AI-Certifications Portal (PGP)" {
				gotActor = true
			}
		}
	}
	if !gotChan {
		t.Errorf("expected a Channel{dm} emit with the store name; lines=%v", lines)
	}
	if !gotActor {
		t.Errorf("expected an Actor emit with the store name; lines=%v", lines)
	}
	e.mu.Lock()
	marked := e.businessNameQueried[biz.String()]
	e.mu.Unlock()
	if !marked {
		t.Error("a JID resolved via the store must be marked businessNameQueried")
	}
}

// TestBusinessNameLookupDrainsPast128 proves STEP 4 (bug: RC3): more than the
// per-call cap of nameless JIDs are drained across bounded BATCHES in a single
// sweep — none are silently dropped by a hard 128-truncation.
func TestBusinessNameLookupDrainsPast128(t *testing.T) {
	e, _ := newTestEngine()

	const total = businessNameBatchSize + 50 // 178 > 128
	nameless := make([]types.JID, 0, total)
	for i := 0; i < total; i++ {
		nameless = append(nameless, types.NewJID(uintToDigits(9000000000+i), types.DefaultUserServer))
	}

	queried := map[string]bool{}
	batches := 0
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		batches++
		for _, j := range jids {
			queried[j.User] = true
		}
		return map[types.JID]types.UserInfo{}, nil
	}
	e.resolveUnsavedBusinessNames("test", nameless)

	if batches < 2 {
		t.Errorf("expected the sweep to span >=2 batches for %d JIDs, got %d", total, batches)
	}
	if len(queried) != total {
		t.Errorf("queried %d distinct JIDs, want all %d drained (no 128-truncation drop)", len(queried), total)
	}
}

// TestLIDAddressedSavedContactResolves proves STEP 6 (bug: RC5): a chat left as a
// bare @lid (no PN mapping when introduced) still resolves its saved-contact name
// once the LID store learns the PN — contactNameForDM tries the PN alias.
func TestLIDAddressedSavedContactResolves(t *testing.T) {
	e, _ := newTestEngine()
	lid := mustJID(t, "88887777@lid")
	pn := mustJID(t, "15551234567@s.whatsapp.net")

	// The contact is saved under the PHONE-NUMBER key (as WhatsApp stores it).
	e.contactNameFn = func(j types.JID) string {
		if j.User == pn.User && j.Server == types.DefaultUserServer {
			return "Mom Smith"
		}
		return "" // a raw @lid lookup misses (the RC5 defect this guards against)
	}

	// A raw contactName on the LID misses (proving the plain path is insufficient).
	if got := e.contactName(lid); got != "" {
		t.Fatalf("raw contactName(@lid) = %q, want empty (LID key misses the PN-keyed store)", got)
	}

	// A canonicalizer that CAN now map this LID -> PN (the store learned it).
	c := &canonicalizer{
		resolveLIDToPN: func(l types.JID) (types.JID, bool) {
			if l.User == lid.User {
				return pn, true
			}
			return types.EmptyJID, false
		},
	}
	if got := e.contactNameForDM(c, lid); got != "Mom Smith" {
		t.Errorf("contactNameForDM(@lid) = %q, want %q (must resolve via PN alias)", got, "Mom Smith")
	}
}

// suppressResweep pins resweepActive=true so refreshKnownNames's single-flight
// guard prevents it spawning the async background re-sweep goroutine. This keeps a
// test that drives refreshKnownNames SYNCHRONOUSLY (and reassigns the userInfoFn/
// contactNameFn seams between sweeps) free of a lingering goroutine that would race
// on those seam reads. The dedicated resweep tests exercise the goroutine itself.
func suppressResweep(e *Engine) {
	e.mu.Lock()
	e.resweepActive = true
	e.mu.Unlock()
}

// introduceDMChannel introduces a DM channel WITHOUT a mapped message (no
// oldestPerChat entry) — the STEP 4 candidate the message-flow-only scan misses.
func introduceDMChannel(e *Engine, id string) {
	// A nameless DM is introduced with an EMPTY channel name (contract §3: no real
	// name -> empty, never the number), which still records it in emittedChans.
	e.emitWithMeta(&protocol.Channel{SourceExtID: id, Name: "", Kind: "dm"}, nil,
		protocol.Event{ExternalID: id + "/M1", ChannelExtID: id, Kind: protocol.KindMessage})
}

// TestRefreshSweepUnionsEmittedChans proves STEP 4: a DM introduced via
// emittedChans (no oldestPerChat entry, i.e. no message flowed through mapMessage)
// is still a candidate — the USync lookup includes it.
func TestRefreshSweepUnionsEmittedChans(t *testing.T) {
	e, _ := newTestEngine()
	suppressResweep(e)
	biz := mustJID(t, "918105749018@s.whatsapp.net")

	// No saved name anywhere -> the DM is nameless and must become a candidate.
	e.contactNameFn = func(j types.JID) string { return "" }

	// Introduce the channel WITHOUT any mapped message: it lands only in emittedChans.
	introduceDMChannel(e, biz.String())
	e.mu.Lock()
	_, inOldest := e.oldestPerChat[biz.String()]
	e.mu.Unlock()
	if inOldest {
		t.Fatal("precondition: the DM must NOT be in oldestPerChat (no mapped message)")
	}

	var queried []types.JID
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		queried = append(queried, jids...)
		return map[types.JID]types.UserInfo{}, nil
	}

	e.refreshKnownNames("test")

	var found bool
	for _, j := range queried {
		if j.User == biz.User {
			found = true
		}
	}
	if !found {
		t.Errorf("emittedChans-only DM %s must be a USync candidate; queried=%v", biz.User, queried)
	}
}

// TestHistorySyncIntroducedDMsAreSwept proves STEP 2: after a simulated history
// sync introduces N nameless DMs, refreshKnownNames queries exactly those N JIDs.
func TestHistorySyncIntroducedDMsAreSwept(t *testing.T) {
	e, _ := newTestEngine()
	suppressResweep(e)
	e.contactNameFn = func(j types.JID) string { return "" } // all nameless

	// Simulate history sync introducing N chats: each gets a channel line (as
	// emitWithMeta would during onHistorySync) but no resolvable name yet.
	want := map[string]bool{}
	for _, u := range []string{"917300073000", "918068422440", "919106399856"} {
		j := mustJID(t, u+"@s.whatsapp.net")
		introduceDMChannel(e, j.String())
		want[j.User] = true
	}

	got := map[string]bool{}
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		for _, j := range jids {
			got[j.User] = true
		}
		return map[types.JID]types.UserInfo{}, nil
	}

	e.refreshKnownNames("history-sync")

	for u := range want {
		if !got[u] {
			t.Errorf("history-sync-introduced DM %s was not swept; got=%v", u, got)
		}
	}
}

// TestResweepResolvesJIDEmptyAtFirstSweep proves STEP 3: a JID that is empty at
// sweep 1 (store not yet populated) is resolved at sweep 2 once the store fills in,
// and introducedNamelessDMs reflects the transition to zero.
func TestResweepResolvesJIDEmptyAtFirstSweep(t *testing.T) {
	e, buf := newTestEngine()
	suppressResweep(e)                               // drive the two sweeps synchronously; no background goroutine
	biz := mustJID(t, "919217010261@s.whatsapp.net") // Zepto

	store := map[string]string{}
	e.contactNameFn = func(j types.JID) string { return store[j.User] }
	introduceDMChannel(e, biz.String())

	// Sweep 1: the USync side-effect populates nothing -> still nameless, retryable.
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		return map[types.JID]types.UserInfo{}, nil
	}
	e.refreshKnownNames("sweep1")
	if n := e.introducedNamelessDMs(); n != 1 {
		t.Fatalf("after sweep 1 introducedNamelessDMs = %d, want 1 (still unresolved)", n)
	}

	// Sweep 2: the call now persists the name into the store -> resolved.
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		for _, j := range jids {
			store[j.User] = "Zepto"
		}
		return map[types.JID]types.UserInfo{}, nil
	}
	e.refreshKnownNames("sweep2")
	if n := e.introducedNamelessDMs(); n != 0 {
		t.Fatalf("after sweep 2 introducedNamelessDMs = %d, want 0 (resolved)", n)
	}

	// The resolved name must have been emitted on a dm channel.
	var emitted bool
	for _, m := range decodeLines(t, buf) {
		if m["t"] == "channel" {
			c := m["channel"].(map[string]any)
			if c["name"] == "Zepto" && c["kind"] == "dm" {
				emitted = true
			}
		}
	}
	if !emitted {
		t.Error("sweep 2 must emit the recovered dm channel name")
	}
}

// TestResweepStopsWhenNoneRemain proves STEP 3: the periodic re-sweep goroutine
// exits promptly once no introduced DM is left nameless (nothing to do).
func TestResweepStopsWhenNoneRemain(t *testing.T) {
	e, _ := newTestEngine()
	biz := mustJID(t, "919538251513@s.whatsapp.net") // Practo AI
	// The DM already has a saved name -> introducedNamelessDMs() == 0 from the start.
	e.contactNameFn = func(j types.JID) string {
		if j.User == biz.User {
			return "Practo AI"
		}
		return ""
	}
	introduceDMChannel(e, biz.String())
	if n := e.introducedNamelessDMs(); n != 0 {
		t.Fatalf("precondition introducedNamelessDMs = %d, want 0 (named)", n)
	}

	// Shrink the backoff so the goroutine's first wake is fast.
	restore := resweepBackoff
	resweepBackoff = []time.Duration{10 * time.Millisecond}
	defer func() { resweepBackoff = restore }()

	e.startBusinessNameResweep()

	// It must clear resweepActive (exit) quickly because there is nothing to sweep.
	deadline := time.Now().Add(2 * time.Second)
	for {
		e.mu.Lock()
		active := e.resweepActive
		e.mu.Unlock()
		if !active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("resweep goroutine did not stop when no nameless DMs remained")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestResweepStopsOnCtxCancel proves STEP 3: the re-sweep goroutine exits on ctx
// cancel (no leak) even while nameless DMs remain.
func TestResweepStopsOnCtxCancel(t *testing.T) {
	e, _ := newTestEngine()
	ctx, cancel := context.WithCancel(context.Background())
	e.ctx = ctx
	biz := mustJID(t, "919667758942@s.whatsapp.net")         // Tata 1mg
	e.contactNameFn = func(j types.JID) string { return "" } // stays nameless forever
	e.userInfoFn = func(ctx context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		return map[types.JID]types.UserInfo{}, nil
	}
	introduceDMChannel(e, biz.String())

	// A long backoff so the goroutine is parked in its select when we cancel.
	restore := resweepBackoff
	resweepBackoff = []time.Duration{time.Hour}
	defer func() { resweepBackoff = restore }()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); e.startBusinessNameResweep() }()
	wg.Wait() // startBusinessNameResweep returns immediately (goroutine keeps running)

	// Give the inner goroutine a moment to enter its select, then cancel.
	time.Sleep(20 * time.Millisecond)
	cancel()

	deadline := time.Now().Add(2 * time.Second)
	for {
		e.mu.Lock()
		active := e.resweepActive
		e.mu.Unlock()
		if !active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("resweep goroutine did not stop on ctx cancel (leak)")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// uintToDigits renders a non-negative int as its decimal digit string (test-only
// helper for synthesizing distinct phone-number JIDs).
func uintToDigits(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// --- WhatsApp's own system accounts (official "WhatsApp" account) -----------
//
// 0@s.whatsapp.net is the PSA/announcements account. WhatsApp ships no name
// for it through any readable channel — no contact-store entry, no
// verified_name cert, no `notify` pushname, no HistorySync Conversation.Name,
// and USync cannot resolve the user part "0". Without officialAccountName the
// chat is emitted nameless and the UI renders "Unknown".

func TestOfficialAccountName(t *testing.T) {
	cases := []struct {
		jid  string
		want string
	}{
		{"0@s.whatsapp.net", "WhatsApp"},
		{"0@c.us", "WhatsApp"},
		{"16505361212@s.whatsapp.net", "WhatsApp"},
		{"16505361212@c.us", "WhatsApp"},
		// Not the official account.
		{"919731006976@s.whatsapp.net", ""},
		{"0@g.us", ""},
		{"0@lid", ""},
		{"status@broadcast", ""},
	}
	for _, tc := range cases {
		j, err := types.ParseJID(tc.jid)
		if err != nil {
			t.Fatalf("ParseJID(%q): %v", tc.jid, err)
		}
		if got := officialAccountName(j); got != tc.want {
			t.Errorf("officialAccountName(%q) = %q, want %q", tc.jid, got, tc.want)
		}
	}
}

// The official account must survive the full chatName/actorName chains with no
// contact store, no pushname and no verified name — i.e. exactly how it arrives.
func TestOfficialAccountNamedEndToEnd(t *testing.T) {
	e := &Engine{}
	chat, err := types.ParseJID("0@s.whatsapp.net")
	if err != nil {
		t.Fatalf("ParseJID: %v", err)
	}
	info := types.MessageInfo{
		MessageSource: types.MessageSource{Chat: chat, Sender: chat, IsFromMe: false},
	}
	if got := e.chatName(info, chat); got != "WhatsApp" {
		t.Errorf("chatName = %q, want %q", got, "WhatsApp")
	}
	if got := e.actorName(info, chat); got != "WhatsApp" {
		t.Errorf("actorName = %q, want %q", got, "WhatsApp")
	}
	// The sweep path (refreshKnownNames / introducedNamelessDMs) must agree, so
	// the account stops being an unresolvable USync candidate forever.
	if got := e.contactNameForDM(nil, chat); got != "WhatsApp" {
		t.Errorf("contactNameForDM = %q, want %q", got, "WhatsApp")
	}
}
