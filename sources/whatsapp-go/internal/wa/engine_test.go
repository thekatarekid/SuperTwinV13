package wa

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// newTestEngine builds an Engine with no whatsmeow client, wired to an
// in-memory protocol Writer whose bytes we can inspect. Name-resolution lookups
// (contacts/groups) return "" without a client, which is exactly the "unknown"
// path we want to exercise for the fallback + late-upgrade logic. e.ctx is set
// to a real context so code paths that derive a timeout (e.g. media download,
// which fails fast without a client) don't panic on a nil parent.
func newTestEngine() (*Engine, *bytes.Buffer) {
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)
	e := New(w, func(string, ...any) {}, "", "", "error")
	e.ctx = context.Background()
	return e, &buf
}

// decodeLines parses the captured NDJSON into generic maps.
func decodeLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad NDJSON line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

// TestGroupSubjectCachedAsName proves a group JID surfaces its subject as the
// channel name (contract §R2.4, bug 4) via the group-name cache, and that a
// later subject change re-emits an UPDATED channel line.
func TestGroupSubjectCachedAsName(t *testing.T) {
	e, buf := newTestEngine()
	group := mustJID(t, "120363000000000001@g.us")

	// Seed the cache the way a GroupInfo lookup/event would.
	e.setGroupName(group, "Weekend Trip")
	if got := e.groupName(group); got != "Weekend Trip" {
		t.Fatalf("groupName cached = %q, want %q", got, "Weekend Trip")
	}

	// First introduction of the channel with the resolved subject.
	id := group.String()
	ch := &protocol.Channel{SourceExtID: id, Name: e.groupName(group), Kind: "group"}
	e.emitWithMeta(ch, nil, protocol.Event{ExternalID: id + "/M1", ChannelExtID: id, Kind: protocol.KindMessage})

	// Subject changes later -> the GroupInfo event path re-emits the channel.
	e.onGroupNameUpdate(group, "Ski Trip 2027")

	lines := decodeLines(t, buf)
	var names []string
	for _, l := range lines {
		if l["t"] == "channel" {
			c := l["channel"].(map[string]any)
			names = append(names, c["name"].(string))
		}
	}
	if len(names) != 2 || names[0] != "Weekend Trip" || names[1] != "Ski Trip 2027" {
		t.Fatalf("group channel names = %v, want [Weekend Trip, Ski Trip 2027]", names)
	}
}

// TestLateNameUpgradeReEmitsActor proves that when a real name is learned AFTER
// a contact was first introduced by number, an UPDATED actor line is emitted
// (contract §R2.4, bug 4). Self is set so canonicalization of the peer is a
// no-op PN.
func TestLateNameUpgradeReEmitsActor(t *testing.T) {
	e, buf := newTestEngine()
	peer := mustJID(t, "15551234567@s.whatsapp.net")
	id := peer.String()

	// First event: no name known -> emitted as the number fallback.
	ac := &protocol.Actor{SourceExtID: id, DisplayName: "+15551234567", Handle: "+15551234567"}
	e.emitWithMeta(nil, ac, protocol.Event{ExternalID: id + "/M1", ActorExtID: id, Kind: protocol.KindMessage})

	// A PushName arrives later. With no client, self is empty, so canonicalize
	// leaves the PN as-is; the learned name flows through.
	e.onNameUpdate(peer, types.EmptyJID, "Hrishikesh")

	// A duplicate push-name event must NOT re-emit (no churn).
	e.onNameUpdate(peer, types.EmptyJID, "Hrishikesh")

	lines := decodeLines(t, buf)
	var names []string
	for _, l := range lines {
		if l["t"] == "actor" {
			a := l["actor"].(map[string]any)
			names = append(names, a["display_name"].(string))
		}
	}
	if len(names) != 2 || names[0] != "+15551234567" || names[1] != "Hrishikesh" {
		t.Fatalf("actor names = %v, want [+15551234567, Hrishikesh]", names)
	}
}

// TestBackfillMapsInitializedAtConstruction proves the crash fix: a freshly
// constructed Engine (no Import/Extend run yet) has non-nil backfill maps, so the
// automatic HistorySync WhatsApp pushes right after pairing can record progress
// without the "assignment to entry in nil map" panic that dropped the ENTIRE
// pushed history. Before the fix, backfill.chatsDone / backfill.inRange were only
// initialized in resetBackfill (start of a user run), so the pre-run write at
// events.go onHistorySync panicked. This asserts both maps are ready at New().
func TestBackfillMapsInitializedAtConstruction(t *testing.T) {
	e, _ := newTestEngine()

	e.backfill.mu.Lock()
	defer e.backfill.mu.Unlock()

	if e.backfill.chatsDone == nil {
		t.Fatal("backfill.chatsDone is nil at construction; a pushed HistorySync would panic (assignment to entry in nil map)")
	}
	if e.backfill.inRange == nil {
		t.Fatal("backfill.inRange is nil at construction; a pushed HistorySync would panic")
	}

	// The exact write that panicked before the fix (events.go onHistorySync) must
	// now be safe on the pre-import path — no run started, chatsDone still writable.
	e.backfill.chatsDone["919999999999@s.whatsapp.net"] = true
	e.backfill.inRange["919999999999@s.whatsapp.net"] = true
	if len(e.backfill.chatsDone) != 1 || len(e.backfill.inRange) != 1 {
		t.Fatalf("pre-run backfill writes did not land: chatsDone=%d inRange=%d",
			len(e.backfill.chatsDone), len(e.backfill.inRange))
	}
}

// TestHandleEventRecoversPanic proves the defense-in-depth guard: a panic inside
// event dispatch is recovered and logged (to the daemon log), never propagated —
// so a single malformed event can NEVER crash the handler or drop a whole
// HistorySync again (the "assignment to entry in nil map" class of bug). We force
// a deterministic nil-map panic in an engine-owned handler by nil-ing groupNames,
// then dispatch a *events.GroupInfo (whose handler writes that map). handleEvent
// must recover the panic, log it, and return normally.
func TestHandleEventRecoversPanic(t *testing.T) {
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)
	var logged strings.Builder
	e := New(w, func(format string, args ...any) {
		logged.WriteString(strings.TrimSpace(strings.ReplaceAll(fmt.Sprintf(format, args...), "\n", " ")))
		logged.WriteString("\n")
	}, "", "", "error")
	e.ctx = context.Background()

	// Force the crash class: a nil engine-owned map. The GroupInfo handler calls
	// setGroupName -> writes e.groupNames, which now panics.
	e.mu.Lock()
	e.groupNames = nil
	e.mu.Unlock()

	group := mustJID(t, "120363000000000009@g.us")
	evt := &events.GroupInfo{JID: group, Name: &types.GroupName{Name: "Panic Trip"}}

	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("handleEvent let a panic escape the recover guard: %v", r)
			}
		}()
		e.handleEvent(evt)
	}()

	if !strings.Contains(logged.String(), "PANIC recovered in handleEvent") {
		t.Fatalf("panic was not logged by the recover guard; log=%q", logged.String())
	}
}

// TestPushedRangeBoundedWithoutRun proves the flood fix: when NO range has been
// installed (no user Import/Extend and no connect-time SetRange), onHistorySync
// filters WhatsApp's automatic post-pairing HistorySync by a BOUNDED default
// (defaultPushedRange), NOT RangeAll. Before the fix, the `!have` branch used
// RangeAll and kept EVERYTHING — the user picked 7 days but got history back to
// January, and extraction was overloaded (~6000 msgs -> 5940 pending events).
func TestPushedRangeBoundedWithoutRun(t *testing.T) {
	// defaultPushedRange itself must be bounded — never "all".
	if defaultPushedRange == protocol.RangeAll {
		t.Fatalf("defaultPushedRange = %q; must be a BOUNDED range, never RangeAll", defaultPushedRange)
	}
	// With no range installed, the pushed-history filter falls back to the bound.
	if got := effectivePushedRange(protocol.RangeAll, false); got != defaultPushedRange {
		t.Fatalf("effectivePushedRange(_, have=false) = %q, want bounded default %q (never RangeAll)", got, defaultPushedRange)
	}
	if got := effectivePushedRange("", false); got == protocol.RangeAll {
		t.Fatal("range-less daemon must not fall back to RangeAll (would flood all history)")
	}
	// Once a range IS installed it is honored verbatim (no clamping).
	for _, r := range []protocol.Range{protocol.Range7d, protocol.Range90d, protocol.RangeAll} {
		if got := effectivePushedRange(r, true); got != r {
			t.Fatalf("effectivePushedRange(%q, have=true) = %q, want %q (installed range honored)", r, got, r)
		}
	}
}

// TestSetRangeInstallsRange proves SetRange records the range for onHistorySync's
// filter (importRange + haveImport) WITHOUT starting a backfill run: no run goes
// active, no progress/backfill_complete is emitted. This is the connect-time
// install the worker uses so pushed history is filtered before it can flood.
func TestSetRangeInstallsRange(t *testing.T) {
	e, buf := newTestEngine()

	// Before: no range installed -> the pushed-history filter would use the bound.
	e.mu.Lock()
	haveBefore := e.haveImport
	e.mu.Unlock()
	if haveBefore {
		t.Fatal("fresh engine must start with haveImport=false")
	}

	e.SetRange(protocol.Range7d)

	e.mu.Lock()
	gotRange := e.importRange
	gotHave := e.haveImport
	e.mu.Unlock()
	if !gotHave || gotRange != protocol.Range7d {
		t.Fatalf("after SetRange: importRange=%q haveImport=%v, want 7d/true", gotRange, gotHave)
	}
	// onHistorySync would now filter by the installed range, not the default.
	if got := effectivePushedRange(gotRange, gotHave); got != protocol.Range7d {
		t.Fatalf("effectivePushedRange after SetRange = %q, want 7d", got)
	}

	// SetRange must NOT start a run: no backfill active, and nothing emitted.
	e.backfill.mu.Lock()
	active := e.backfill.active
	e.backfill.mu.Unlock()
	if active {
		t.Fatal("SetRange must not start a backfill run (backfill.active should stay false)")
	}
	if strings.TrimSpace(buf.String()) != "" {
		t.Fatalf("SetRange must emit no protocol frames, got: %q", buf.String())
	}
}

// TestStableNameEmittedOnce proves a channel/actor with an already-good name is
// emitted exactly once across repeated events (no duplicate channel lines).
func TestStableNameEmittedOnce(t *testing.T) {
	e, buf := newTestEngine()
	id := "15551234567@s.whatsapp.net"
	ch := &protocol.Channel{SourceExtID: id, Name: "Mom", Kind: "dm"}
	for i := 0; i < 3; i++ {
		e.emitWithMeta(ch, nil, protocol.Event{ExternalID: id + "/M", ChannelExtID: id, Kind: protocol.KindMessage})
	}
	lines := decodeLines(t, buf)
	channels := 0
	for _, l := range lines {
		if l["t"] == "channel" {
			channels++
		}
	}
	if channels != 1 {
		t.Fatalf("emitted %d channel lines for a stable name, want 1", channels)
	}
}
