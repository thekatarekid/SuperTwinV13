package mock

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

func decodeLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad NDJSON %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

// TestMockLogoutClearsSessionAndEmitsLoggedOut proves the mock engine's logout
// (mirroring the real daemon, contract §R3.1): it clears paired/import state and
// emits `status logged_out`. The daemon then takes the clean-exit path.
func TestMockLogoutClearsSessionAndEmitsLoggedOut(t *testing.T) {
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)
	e := New(w, func(string, ...any) {}, BuiltinFixture(), t.TempDir())

	// Pair + import so there is session/import state to clear.
	e.StartPairing()
	e.Import(protocol.Range24h)

	e.Logout()

	// Paired state cleared.
	e.mu.Lock()
	paired := e.paired
	haveRange := e.haveRange
	e.mu.Unlock()
	if paired {
		t.Error("logout must clear paired state")
	}
	if haveRange {
		t.Error("logout must clear import range state")
	}

	// A `status logged_out` line was emitted.
	lines := decodeLines(t, &buf)
	loggedOut := false
	for _, l := range lines {
		if l["t"] == "status" && l["state"] == string(protocol.StateLoggedOut) {
			loggedOut = true
		}
	}
	if !loggedOut {
		t.Fatalf("logout must emit status logged_out; got lines: %v", lines)
	}
}

// TestMockFiltersNoiseChats proves the mock plan drops status@broadcast and
// @newsletter chats and contentless system messages (contract §R4.3, bug 17),
// while keeping the business chat's non-plain message.
func TestMockFiltersNoiseChats(t *testing.T) {
	f := BuiltinFixture()
	p := f.BuildPlan(protocol.RangeAll, testNow)

	for _, c := range p.Channels {
		if strings.HasSuffix(c.SourceExtID, "@broadcast") || strings.HasSuffix(c.SourceExtID, "@newsletter") {
			t.Errorf("noise channel leaked into plan: %q", c.SourceExtID)
		}
	}
	for _, ev := range p.Events {
		if ev.Msg.MessageID == "STATUS_1" || ev.Msg.MessageID == "NEWS_1" {
			t.Errorf("noise message %q leaked into plan", ev.Msg.MessageID)
		}
		if ev.Msg.MessageID == "SELF_SYS_1" {
			t.Error("contentless system message SELF_SYS_1 leaked into plan (bug 17)")
		}
	}

	// The business chat's message IS present.
	foundBiz := false
	for _, ev := range p.Events {
		if ev.Msg.MessageID == "BIZ_0001" {
			foundBiz = true
		}
	}
	if !foundBiz {
		t.Error("business message BIZ_0001 must ingest (bug 16)")
	}
}

// TestMockRangeProgressInRangeTotalAndDone proves the contract §R6.3 behavior:
// for a 24h import, progress.chats_total is the count of IN-RANGE chats (NOT the
// full fixture chat count), progress reaches chats_done == chats_total, a
// progress done:true frame fires, and backfill_complete is emitted — so the
// import banner clears (no permanent "N/<big total>").
func TestMockRangeProgressInRangeTotalAndDone(t *testing.T) {
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)
	f := BuiltinFixture()
	e := New(w, func(string, ...any) {}, f, t.TempDir())

	e.StartPairing()
	e.Import(protocol.Range24h)

	// The in-range set for 24h, computed independently from the plan, is the
	// number of distinct channels the 24h plan emits — and must be SMALLER than
	// the full fixture chat set (proving chats_total = in-range, not total). The
	// engine uses time.Now(); the fixture's "ago" offsets are days apart so the
	// in-range set is stable regardless of the exact instant.
	plan := f.BuildPlan(protocol.Range24h, time.Now())
	inRange := len(plan.Channels)

	// Count distinct real (non-noise) chats in the whole fixture for the "< total"
	// assertion.
	totalChats := map[string]bool{}
	for _, c := range f.Chats {
		if !skipMockChatJID(c.JID) {
			totalChats[f.canonJID(c.JID)] = true
		}
	}
	if inRange >= len(totalChats) {
		t.Fatalf("test setup: 24h in-range (%d) must be < total chats (%d) to prove partial coverage", inRange, len(totalChats))
	}
	if inRange == 0 {
		t.Fatal("test setup: 24h range must have at least one in-range chat")
	}

	var lastProgress map[string]any
	sawDone := false
	sawComplete := false
	for _, l := range decodeLines(t, &buf) {
		switch l["t"] {
		case "progress":
			if l["phase"] == "backfill" {
				lastProgress = l
				if d, _ := l["done"].(bool); d {
					sawDone = true
					if ct, _ := l["chats_total"].(float64); int(ct) != inRange {
						t.Errorf("done-progress chats_total = %v, want in-range count %d", ct, inRange)
					}
					if cd, _ := l["chats_done"].(float64); int(cd) != inRange {
						t.Errorf("done-progress chats_done = %v, want %d (all in-range covered)", cd, inRange)
					}
				}
			}
		case "backfill_complete":
			sawComplete = true
			if c, _ := l["chats"].(float64); int(c) != inRange {
				t.Errorf("backfill_complete chats = %v, want in-range count %d", c, inRange)
			}
		}
	}
	if !sawDone {
		t.Fatal("a progress done:true frame must fire so the banner clears (contract §R6.3)")
	}
	if !sawComplete {
		t.Fatal("backfill_complete must fire (contract §R6.3)")
	}
	if ct, _ := lastProgress["chats_total"].(float64); int(ct) != inRange {
		t.Errorf("final backfill progress chats_total = %v, want in-range count %d (not the full chat total)", ct, inRange)
	}
}

// TestMockPlateauCompletesViaQuietWindow proves the contract §R7.2 fix in the
// mock: when the fixture declares in-range chats that deliver NO messages
// (EmptyInRangeChats), chats_done PLATEAUS below chats_total — exactly like a
// large/entire real import where WhatsApp never pushes history for inactive
// chats. Completion must STILL fire (progress done:true + backfill_complete)
// after the delivered chats finish (the simulated quiet window), leaving
// chats_done < chats_total, so the banner clears. It must fire exactly once.
func TestMockPlateauCompletesViaQuietWindow(t *testing.T) {
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)

	// Two DMs that DO deliver a recent message each, plus 5 phantom in-range chats
	// that deliver nothing. So chats_total = 2 delivered + 5 phantom = 7, but
	// chats_done tops out at 2.
	f := &Fixture{
		EmptyInRangeChats: 5,
		Chats: []FixtureChat{
			{JID: "111@s.whatsapp.net", Name: "Ann", Kind: "dm"},
			{JID: "222@s.whatsapp.net", Name: "Ben", Kind: "dm"},
		},
		Actors: []FixtureActor{
			{JID: "111@s.whatsapp.net", DisplayName: "Ann", Handle: "+111"},
			{JID: "222@s.whatsapp.net", DisplayName: "Ben", Handle: "+222"},
		},
		Messages: []FixtureMessage{
			{ChatJID: "111@s.whatsapp.net", SenderJID: "111@s.whatsapp.net", MessageID: "A1", AgoSeconds: 3600, Kind: "message", Text: "hi"},
			{ChatJID: "222@s.whatsapp.net", SenderJID: "222@s.whatsapp.net", MessageID: "B1", AgoSeconds: 7200, Kind: "message", Text: "yo"},
		},
	}
	e := New(w, func(string, ...any) {}, f, t.TempDir()).WithQuietWindow(20 * time.Millisecond)

	e.StartPairing()
	e.Import(protocol.Range24h)

	doneFrames, complete, lastDone, lastTotal := countMockCompletions(t, &buf)
	if doneFrames < 1 {
		t.Fatal("a progress done:true frame must fire even when chats plateau (contract §R7.2)")
	}
	if complete != 1 {
		t.Fatalf("backfill_complete fired %d times, want exactly 1 (once-only)", complete)
	}
	const wantDone, wantTotal = 2, 7
	if lastDone != wantDone || lastTotal != wantTotal {
		t.Fatalf("terminal done frame = %d/%d, want %d/%d (chats_done must plateau BELOW chats_total)", lastDone, lastTotal, wantDone, wantTotal)
	}
	if lastDone >= lastTotal {
		t.Fatalf("contract §R7.2: mock completion must fire with chats_done (%d) < chats_total (%d)", lastDone, lastTotal)
	}
	if complete, _ := lastBackfillCompleteChats(t, &buf); complete != wantDone {
		t.Fatalf("backfill_complete chats = %d, want the delivered count %d (not the inflated total)", complete, wantDone)
	}
}

// TestMockNormalSmallImportCompletesAsBefore proves the plateau change did NOT
// regress the normal path (contract §R7.2 "a normal small import still completes
// as before"): with NO phantom chats, chats_done reaches chats_total and a single
// done:true + backfill_complete fires with chats_done == chats_total.
func TestMockNormalSmallImportCompletesAsBefore(t *testing.T) {
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)
	f := &Fixture{
		Chats: []FixtureChat{
			{JID: "111@s.whatsapp.net", Name: "Ann", Kind: "dm"},
			{JID: "222@s.whatsapp.net", Name: "Ben", Kind: "dm"},
		},
		Actors: []FixtureActor{
			{JID: "111@s.whatsapp.net", DisplayName: "Ann", Handle: "+111"},
			{JID: "222@s.whatsapp.net", DisplayName: "Ben", Handle: "+222"},
		},
		Messages: []FixtureMessage{
			{ChatJID: "111@s.whatsapp.net", SenderJID: "111@s.whatsapp.net", MessageID: "A1", AgoSeconds: 3600, Kind: "message", Text: "hi"},
			{ChatJID: "222@s.whatsapp.net", SenderJID: "222@s.whatsapp.net", MessageID: "B1", AgoSeconds: 7200, Kind: "message", Text: "yo"},
		},
	}
	// A LONG quiet window: if the normal path wrongly took the quiet branch this
	// test would hang far beyond its expected instant completion.
	e := New(w, func(string, ...any) {}, f, t.TempDir()).WithQuietWindow(30 * time.Second)

	e.StartPairing()
	start := time.Now()
	e.Import(protocol.Range24h)
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("normal small import took %v; it must NOT wait on the quiet window", elapsed)
	}

	doneFrames, complete, lastDone, lastTotal := countMockCompletions(t, &buf)
	if doneFrames < 1 || complete != 1 {
		t.Fatalf("normal import must fire exactly one done + backfill_complete; got done=%d complete=%d", doneFrames, complete)
	}
	if lastDone != 2 || lastTotal != 2 {
		t.Fatalf("normal import terminal frame = %d/%d, want 2/2 (chats_done == chats_total)", lastDone, lastTotal)
	}
}

// countMockCompletions counts progress-done:true and backfill_complete lines and
// returns the last done-progress chats_done / chats_total (mirrors the wa test
// helper for the mock's NDJSON).
func countMockCompletions(t *testing.T, buf *bytes.Buffer) (doneFrames, complete, lastDone, lastTotal int) {
	t.Helper()
	for _, l := range decodeLines(t, buf) {
		switch l["t"] {
		case "progress":
			if d, _ := l["done"].(bool); d {
				doneFrames++
				if cd, ok := l["chats_done"].(float64); ok {
					lastDone = int(cd)
				}
				if ct, ok := l["chats_total"].(float64); ok {
					lastTotal = int(ct)
				}
			}
		case "backfill_complete":
			complete++
		}
	}
	return
}

// lastBackfillCompleteChats returns the chats/messages of the LAST
// backfill_complete line.
func lastBackfillCompleteChats(t *testing.T, buf *bytes.Buffer) (chats, messages int) {
	t.Helper()
	for _, l := range decodeLines(t, buf) {
		if l["t"] == "backfill_complete" {
			if c, ok := l["chats"].(float64); ok {
				chats = int(c)
			}
			if m, ok := l["messages"].(float64); ok {
				messages = int(m)
			}
		}
	}
	return
}

// TestMockExtendWidensCoverageAcrossChats proves the contract §R6.4 coverage
// intent in the mock model: importing 24h then extending to 30d pulls the OLDER
// messages of a deep-history chat up to the wider cutoff — across a multi-message
// chat — that the narrow import excluded. Extend must reach every older message
// newer than the 30d cutoff (here DEEP_D2/D5/D9/D20/D28), proving it doesn't just
// top up one batch.
func TestMockExtendWidensCoverageAcrossChats(t *testing.T) {
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)
	f := BuiltinFixture()
	e := New(w, func(string, ...any) {}, f, t.TempDir())

	e.StartPairing()
	e.Import(protocol.Range24h) // narrow: only DEEP_R is in range for Subhashree
	e.Extend(protocol.Range30d) // widen: must pull DEEP_D2..D28 (all < 30d)

	// Collect the message ids emitted as events across BOTH runs.
	seen := map[string]bool{}
	for _, l := range decodeLines(t, &buf) {
		if l["t"] != "event" {
			continue
		}
		ev, _ := l["event"].(map[string]any)
		raw, _ := ev["raw"].(map[string]any)
		if id, ok := raw["id"].(string); ok {
			seen[id] = true
		}
	}

	// After the 24h import, only the recent Subhashree message is present.
	if !seen["DEEP_R"] {
		t.Error("recent deep-chat message DEEP_R must be imported in the 24h run")
	}
	// After extending to 30d, every deep-chat message newer than the 30d cutoff
	// must be covered — across the whole chat, not just one older batch.
	wantAfterExtend := []string{"DEEP_D2", "DEEP_D5", "DEEP_D9", "DEEP_D20", "DEEP_D28"}
	for _, id := range wantAfterExtend {
		if !seen[id] {
			t.Errorf("extend to 30d must cover older deep-chat message %q (contract §R6.4)", id)
		}
	}
	// A message OLDER than 30d (if any) must NOT be pulled by a 30d extend. The
	// fixture's deep chat bottoms out at 28d, so nothing to over-pull here; guard
	// that the 200d MOM_0004 is not present.
	if seen["MOM_0004"] {
		t.Error("30d extend must not pull the 200d-old MOM_0004 (out of range)")
	}
}

// TestMockEmitsReactionAndReply proves the mock replays the reaction and
// quoted-reply fixtures through the NDJSON protocol with the new fields set
// (contract §R5.3/§R5.4), so the worker↔UI pipeline can be tested end-to-end:
//   - the reaction event has kind=reaction, text=emoji, reply_to_external_id
//     pointing at its target;
//   - the quoted reply event carries reply_to = {external_id, text, actor_ext_id};
//   - the business template event carries REAL text (never "[template message]")
//     from a verified-named channel.
func TestMockEmitsReactionAndReply(t *testing.T) {
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)
	e := New(w, func(string, ...any) {}, BuiltinFixture(), t.TempDir())

	e.StartPairing()
	e.Import(protocol.RangeAll)

	var reaction, reply, biz map[string]any
	var bizChannel map[string]any
	for _, l := range decodeLines(t, &buf) {
		if l["t"] == "event" {
			ev, _ := l["event"].(map[string]any)
			raw, _ := ev["raw"].(map[string]any)
			switch raw["id"] {
			case "MOM_REACT_1":
				reaction = ev
			case "GRP_0005":
				reply = ev
			case "BIZ_0001":
				biz = ev
			}
		}
		if l["t"] == "channel" {
			ch, _ := l["channel"].(map[string]any)
			if ch["source_ext_id"] == "15551112222@s.whatsapp.net" {
				bizChannel = ch
			}
		}
	}

	// Reaction.
	if reaction == nil {
		t.Fatal("mock must emit the reaction event MOM_REACT_1 (contract §R5.3)")
	}
	if reaction["kind"] != "reaction" {
		t.Errorf("reaction kind = %v, want reaction", reaction["kind"])
	}
	if reaction["text"] != "👍" {
		t.Errorf("reaction text = %v, want the emoji", reaction["text"])
	}
	if reaction["reply_to_external_id"] != "15551234567@s.whatsapp.net/MOM_0001" {
		t.Errorf("reaction reply_to_external_id = %v, want the target id", reaction["reply_to_external_id"])
	}

	// Quoted reply.
	if reply == nil {
		t.Fatal("mock must emit the quoted-reply event GRP_0005 (contract §R5.4)")
	}
	rt, ok := reply["reply_to"].(map[string]any)
	if !ok || rt == nil {
		t.Fatalf("reply_to must be an object on GRP_0005; got %v", reply["reply_to"])
	}
	if rt["external_id"] != "120363000000000001@g.us/GRP_0002" {
		t.Errorf("reply_to.external_id = %v, want the quoted target", rt["external_id"])
	}
	if rt["text"] != "I can. Meet at 9am." {
		t.Errorf("reply_to.text = %v, want the quoted text", rt["text"])
	}
	if rt["actor_ext_id"] != "15550002222@s.whatsapp.net" {
		t.Errorf("reply_to.actor_ext_id = %v, want the quoted sender", rt["actor_ext_id"])
	}

	// Business template real text + verified-named channel.
	if biz == nil {
		t.Fatal("mock must emit the business template event BIZ_0001")
	}
	if biz["text"] == "[template message]" || biz["text"] == "" {
		t.Errorf("business text = %v, must be the REAL body (contract §R5.2)", biz["text"])
	}
	if bizChannel == nil || bizChannel["name"] != "Acme Support" {
		t.Errorf("business channel name = %v, want verified name Acme Support", bizChannel)
	}
}

// TestMockEventsAreHistorical proves the replay is honest about what it is
// (v4-spec §4b). The mock has no live socket: every event it emits comes out of a
// fixture during a backfill, so a mock that reported them as live arrivals would
// let the worker's media queue validate a fast path production never takes.
func TestMockEventsAreHistorical(t *testing.T) {
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)
	e := New(w, func(string, ...any) {}, BuiltinFixture(), t.TempDir())
	e.StartPairing()
	e.Import(protocol.Range7d)

	events := 0
	for _, line := range decodeLines(t, &buf) {
		if line["t"] != "event" {
			continue
		}
		events++
		ev := line["event"].(map[string]any)
		if ev["is_historical"] != true {
			t.Fatalf("replayed event %v is not marked historical", ev["external_id"])
		}
	}
	if events == 0 {
		t.Fatal("the mock emitted no events to check")
	}
}
