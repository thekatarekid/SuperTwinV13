package wa

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// logSink is a concurrency-safe logf capture. The paginator's arming decision and
// the per-payload history-sync accounting are DIAGNOSTIC output — the log is
// their only surface — so the tests that cover them assert on the log the same
// way an operator would read it.
type logSink struct {
	mu sync.Mutex
	sb strings.Builder
}

func (l *logSink) logf(format string, args ...any) {
	l.mu.Lock()
	l.sb.WriteString(strings.TrimSpace(fmt.Sprintf(format, args...)))
	l.sb.WriteByte('\n')
	l.mu.Unlock()
}

func (l *logSink) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sb.String()
}

// newLoggedEngine is newTestEngine with the diagnostic log captured.
func newLoggedEngine() (*Engine, *bytes.Buffer, *logSink) {
	var buf bytes.Buffer
	sink := &logSink{}
	w := protocol.NewWriter(&buf)
	e := New(w, sink.logf, "", "", "error")
	e.ctx = context.Background()
	return e, &buf, sink
}

// historyBatch builds a one-conversation history-sync payload whose messages all
// land at `at`, and wires the parse seam so they map without a live client.
func historyBatch(e *Engine, chat string, at time.Time, ids ...string) *events.HistorySync {
	e.parseWebMsgFn = func(c types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error) {
		return &events.Message{
			Info: types.MessageInfo{
				ID:            webMsg.GetKey().GetID(),
				Timestamp:     time.Unix(int64(webMsg.GetMessageTimestamp()), 0),
				MessageSource: types.MessageSource{Chat: c, Sender: c},
			},
			Message:      &waE2E.Message{Conversation: strp("hi")},
			SourceWebMsg: webMsg,
		}, nil
	}
	var msgs []*waHistorySync.HistorySyncMsg
	for _, id := range ids {
		msgs = append(msgs, &waHistorySync.HistorySyncMsg{Message: &waWeb.WebMessageInfo{
			Key:              &waCommon.MessageKey{ID: strp(id), RemoteJID: strp(chat)},
			MessageTimestamp: u64p(uint64(at.Unix())),
		}})
	}
	return &events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType:   waHistorySync.HistorySync_RECENT.Enum(),
		ChunkOrder: u32p(1),
		Progress:   u32p(12),
		Conversations: []*waHistorySync.Conversation{{
			ID:               strp(chat),
			LastMsgTimestamp: u64p(uint64(at.Unix())),
			Messages:         msgs,
		}},
	}}
}

// TestPaginatorDeferredUntilAnchorsExist is the core proof for the bug that made
// back-pagination a guaranteed no-op. requestOlderHistory can only walk chats
// present in e.oldestPerChat, which trackAnchor fills from ALREADY-MAPPED
// messages — so calling it inline from Import, before any history has arrived,
// always found zero anchors, sent zero requests and settled instantly. Import
// must now start no paginator at all, and the FIRST history batch must arm it.
func TestPaginatorDeferredUntilAnchorsExist(t *testing.T) {
	e, _, log := newLoggedEngine()
	chat := "918884542333@s.whatsapp.net"
	at := time.Now().Add(-2 * time.Hour)

	e.Import(protocol.Range7d)

	if n := e.anchorCount(); n != 0 {
		t.Fatalf("precondition: a fresh Import must have no anchors, got %d", n)
	}
	e.backfill.mu.Lock()
	armed := e.backfill.paginatorArmed
	e.backfill.mu.Unlock()
	if armed {
		t.Fatal("Import must NOT arm the paginator inline: with zero anchors it can only send zero requests and settle instantly")
	}
	if strings.Contains(log.String(), "paginator: run") {
		t.Fatalf("Import must not invoke the paginator at all; log=%q", log.String())
	}

	// The first history batch produces anchors -> the paginator is armed exactly now.
	e.processHistorySync(historyBatch(e, chat, at, "M1"))

	if n := e.anchorCount(); n != 1 {
		t.Fatalf("a mapped history message must record an anchor; anchors=%d, want 1", n)
	}
	e.backfill.mu.Lock()
	armed = e.backfill.paginatorArmed
	e.backfill.mu.Unlock()
	if !armed {
		t.Fatal("the first history batch must arm the paginator (it is the first moment anchors exist)")
	}
	if !strings.Contains(log.String(), "paginator: arming for import run") {
		t.Fatalf("arming must be logged with its reason; log=%q", log.String())
	}

	// Once per run: a second batch must not start a competing paginator.
	before := strings.Count(log.String(), "paginator: arming for import run")
	e.processHistorySync(historyBatch(e, chat, at.Add(time.Minute), "M2"))
	if after := strings.Count(log.String(), "paginator: arming for import run"); after != before {
		t.Fatalf("paginator armed %d times across 2 batches, want %d (once per run)", after, before)
	}
}

// TestPaginatorDoesNotCompleteZeroBatchRun proves the second half of the bug: a
// paginator settle over zero anchors is vacuously "every chat covered", which is
// how a run reported a finished backfill 15s BEFORE its first history batch
// landed. The paginator path must refuse to close an import run that has seen
// neither a batch nor an anchor, leaving completion to the quiet watcher.
func TestPaginatorDoesNotCompleteZeroBatchRun(t *testing.T) {
	e, buf, _ := newLoggedEngine()

	run := e.resetBackfill(protocol.Range7d, false) // import run, zero batches, zero anchors.
	if e.finishBackfillFromPaginator(run, protocol.Range7d) {
		t.Fatal("the paginator must NOT complete an import run with zero batches AND zero anchors")
	}
	e.backfill.mu.Lock()
	active := e.backfill.active
	e.backfill.mu.Unlock()
	if !active {
		t.Fatal("the run must stay open for the quiet watcher after the paginator refuses it")
	}
	if _, complete, _, _ := countCompletions(t, buf); complete != 0 {
		t.Fatalf("backfill_complete fired %d times for a zero-batch run, want 0", complete)
	}

	// A run whose batch has gone quiet completes normally through the same path.
	e.quietWindow = time.Millisecond
	e.noteHistoryBatch(false)
	time.Sleep(3 * time.Millisecond)
	if !e.finishBackfillFromPaginator(run, protocol.Range7d) {
		t.Fatal("the paginator must complete a run that has processed >=1 history-sync batch and gone quiet")
	}
	if _, complete, _, _ := countCompletions(t, buf); complete != 1 {
		t.Fatalf("backfill_complete fired %d times, want exactly 1", complete)
	}
}

// TestPaginatorDoesNotCompleteWhileHistoryStillArriving proves the paginator
// cannot clear the banner mid-stream. It drains the anchors it happens to hold
// long before WhatsApp finishes pushing, so a settle while batches are still
// landing would report a finished backfill over a partial import — the same
// user-visible symptom as the zero-anchor settle, one step later.
func TestPaginatorDoesNotCompleteWhileHistoryStillArriving(t *testing.T) {
	e, buf, log := newLoggedEngine()
	e.quietWindow = 10 * time.Second // history counts as "still arriving".

	run := e.resetBackfill(protocol.Range7d, false)
	e.noteHistoryBatch(false) // a batch just landed.

	if e.finishBackfillFromPaginator(run, protocol.Range7d) {
		t.Fatal("the paginator must NOT complete a run whose last history batch is still inside the quiet window")
	}
	if _, complete, _, _ := countCompletions(t, buf); complete != 0 {
		t.Fatalf("backfill_complete fired %d times mid-stream, want 0", complete)
	}
	if !strings.Contains(log.String(), "history still arriving") {
		t.Fatalf("the refusal must name its reason; log=%q", log.String())
	}
}

// TestImportStartsPaginatorOverDrainedAnchors covers the onboarding path. The
// post-pairing bootstrap is buffered before the user picks a range and drained by
// Import itself, so the whole of it can land BEFORE the run opens and no further
// batch is owed. Anchors exist by then, so Import must start the paginator rather
// than wait for a batch that will never come.
func TestImportStartsPaginatorOverDrainedAnchors(t *testing.T) {
	e, _, log := newLoggedEngine()
	chat := "918884542333@s.whatsapp.net"
	at := time.Now().Add(-2 * time.Hour)

	// Bootstrap arrives before any range -> buffered.
	e.onHistorySync(historyBatch(e, chat, at, "M1"))
	e.mu.Lock()
	buffered := len(e.pendingHistory)
	e.mu.Unlock()
	if buffered != 1 {
		t.Fatalf("precondition: bootstrap must buffer; pendingHistory=%d, want 1", buffered)
	}

	e.Import(protocol.Range7d)

	if n := e.anchorCount(); n != 1 {
		t.Fatalf("the drained bootstrap must leave an anchor; anchors=%d, want 1", n)
	}
	e.backfill.mu.Lock()
	armed := e.backfill.paginatorArmed
	e.backfill.mu.Unlock()
	if !armed {
		t.Fatal("Import must start the paginator when the drained bootstrap already produced anchors")
	}
	if !strings.Contains(log.String(), "from the drained bootstrap") {
		t.Fatalf("the drained-bootstrap arm must be logged; log=%q", log.String())
	}
}

// TestPaginatorCompletesExtendWithoutBatches proves the zero-batch guard does not
// strand an EXTEND. An extend's only history is ON_DEMAND responses, which
// deliberately never bump the batch counter (noteHistoryBatch), so its paginator
// still owns completion (contract §R6.4).
func TestPaginatorCompletesExtendWithoutBatches(t *testing.T) {
	e, buf, _ := newLoggedEngine()

	run := e.resetBackfill(protocol.Range90d, true) // extend run, zero batches.
	if !e.finishBackfillFromPaginator(run, protocol.Range90d) {
		t.Fatal("the paginator must still complete an EXTEND run: ON_DEMAND batches never bump the batch counter")
	}
	if _, complete, _, _ := countCompletions(t, buf); complete != 1 {
		t.Fatalf("backfill_complete fired %d times for an extend, want exactly 1", complete)
	}
}

// TestZeroBatchRunTerminatesAtDeadline proves the guard stays BOUNDED: with the
// paginator refusing a zero-batch run and the quiet window unable to arm without
// a batch, nothing else could close a run that never receives history. The quiet
// watcher's zero-batch deadline terminates it and says so.
func TestZeroBatchRunTerminatesAtDeadline(t *testing.T) {
	e, buf, log := newLoggedEngine()
	e.quietWindow = 20 * time.Millisecond
	e.noHistoryDeadline = 60 * time.Millisecond
	completed := watchCompletion(e)

	run := e.resetBackfill(protocol.Range24h, false) // no batch will ever arrive.
	go e.watchQuietCompletion(run, protocol.Range24h)

	awaitCompletion(t, completed, 2*time.Second)

	if _, complete, _, _ := countCompletions(t, buf); complete != 1 {
		t.Fatalf("a run that never receives history must still terminate exactly once, got %d", complete)
	}
	if !strings.Contains(log.String(), "ZERO history-sync batches") {
		t.Fatalf("a zero-history run must say so in the log rather than look like a healthy import; log=%q", log.String())
	}
}

// TestSeedAnchorsSurvivesRestart proves anchor durability. e.oldestPerChat is
// in-memory and filled only from messages THIS process mapped, so after a daemon
// restart it is empty and "Extend history" paginates nothing at all. The worker
// re-seeds it from its own events table; the four seeded fields are exactly what
// whatsmeow's BuildHistorySyncRequest puts on the wire.
func TestSeedAnchorsSurvivesRestart(t *testing.T) {
	chat := "918884542333@s.whatsapp.net"
	oldest := time.Now().Add(-30 * 24 * time.Hour).Truncate(time.Second)

	// --- process 1: history arrives and records an anchor ---
	e1, _, _ := newLoggedEngine()
	e1.SetRange(protocol.Range90d)
	e1.processHistorySync(historyBatch(e1, chat, oldest, "OLDEST"))
	if n := e1.anchorCount(); n != 1 {
		t.Fatalf("precondition: process 1 must hold 1 anchor, got %d", n)
	}

	// --- process 2: a restart. The anchor map starts EMPTY. ---
	e2, _, log := newLoggedEngine()
	if n := e2.anchorCount(); n != 0 {
		t.Fatalf("a restarted daemon must start with no anchors, got %d", n)
	}

	// The worker replays what its DB knows for this chat.
	e2.SeedAnchors([]protocol.Anchor{{
		ChatJID: chat,
		MsgID:   "OLDEST",
		FromMe:  false,
		TS:      protocol.FormatTime(oldest),
	}})

	if n := e2.anchorCount(); n != 1 {
		t.Fatalf("seed_anchors must restore the anchor; anchors=%d, want 1", n)
	}
	e2.mu.Lock()
	got := e2.oldestPerChat[chat]
	e2.mu.Unlock()
	// Exactly the fields BuildHistorySyncRequest reads (send.go: ChatJID,
	// OldestMsgID, OldestMsgFromMe, OldestMsgTimestampMS).
	if got.Chat.String() != chat {
		t.Fatalf("seeded anchor chat = %q, want %q", got.Chat.String(), chat)
	}
	if got.ID != "OLDEST" {
		t.Fatalf("seeded anchor id = %q, want %q", got.ID, "OLDEST")
	}
	if got.IsFromMe {
		t.Fatal("seeded anchor from_me must round-trip as false")
	}
	if !got.Timestamp.Equal(oldest) {
		t.Fatalf("seeded anchor ts = %s, want %s", got.Timestamp, oldest)
	}
	if !strings.Contains(log.String(), "seed_anchors: 1 seeded") {
		t.Fatalf("seeding must be logged; log=%q", log.String())
	}
}

// TestSeedAnchorsNeverWalksAnAnchorForward proves seeding is safe against a stale
// or coarser worker view: it goes through trackAnchor, which only ever moves an
// anchor OLDER. A newer seed landing on top of a live anchor would otherwise
// re-request history the daemon already holds.
func TestSeedAnchorsNeverWalksAnAnchorForward(t *testing.T) {
	e, _, _ := newLoggedEngine()
	chat := "918884542333@s.whatsapp.net"
	old := time.Now().Add(-30 * 24 * time.Hour).Truncate(time.Second)
	newer := old.Add(48 * time.Hour)

	e.SeedAnchors([]protocol.Anchor{{ChatJID: chat, MsgID: "OLD", TS: protocol.FormatTime(old)}})
	e.SeedAnchors([]protocol.Anchor{{ChatJID: chat, MsgID: "NEW", TS: protocol.FormatTime(newer)}})

	e.mu.Lock()
	got := e.oldestPerChat[chat]
	e.mu.Unlock()
	if got.ID != "OLD" || !got.Timestamp.Equal(old) {
		t.Fatalf("anchor = %s@%s, want OLD@%s (a newer seed must never walk the anchor forward)", got.ID, got.Timestamp, old)
	}

	// An older seed IS accepted (it widens what we can still page back to).
	older := old.Add(-72 * time.Hour)
	e.SeedAnchors([]protocol.Anchor{{ChatJID: chat, MsgID: "OLDER", TS: protocol.FormatTime(older)}})
	e.mu.Lock()
	got = e.oldestPerChat[chat]
	e.mu.Unlock()
	if got.ID != "OLDER" || !got.Timestamp.Equal(older) {
		t.Fatalf("anchor = %s@%s, want OLDER@%s", got.ID, got.Timestamp, older)
	}
}

// TestSeedAnchorsRejectsIncompleteEntries proves a partial anchor is dropped
// rather than turned into a malformed page request. WhatsApp is asked for
// "messages older than THIS message in THIS chat", so a missing id, chat or
// timestamp makes the request meaningless.
func TestSeedAnchorsRejectsIncompleteEntries(t *testing.T) {
	e, _, log := newLoggedEngine()
	ts := protocol.FormatTime(time.Now().Add(-time.Hour))

	e.SeedAnchors([]protocol.Anchor{
		{ChatJID: "", MsgID: "A", TS: ts},                            // no chat
		{ChatJID: "918884542333@s.whatsapp.net", MsgID: "", TS: ts},  // no id
		{ChatJID: "918884542333@s.whatsapp.net", MsgID: "B", TS: ""}, // no ts
		{ChatJID: "918884542333@s.whatsapp.net", MsgID: "C", TS: "not-a-time"},
		{ChatJID: "status@broadcast", MsgID: "D", TS: ts},            // never ingested
		{ChatJID: "918884542333@s.whatsapp.net", MsgID: "E", TS: ts}, // the only good one
	})

	if n := e.anchorCount(); n != 1 {
		t.Fatalf("anchors=%d, want 1 (only the complete, ingestable entry)", n)
	}
	if !strings.Contains(log.String(), "5 skipped") {
		t.Fatalf("skipped anchors must be counted in the log; log=%q", log.String())
	}
}

// TestHistorySyncRangeFilteringUnchanged guards the filters the arming/accounting
// changes run alongside: an in-range message still emits, an out-of-range message
// in the SAME conversation is still dropped, and the per-payload log reports both.
func TestHistorySyncRangeFilteringUnchanged(t *testing.T) {
	e, buf, log := newLoggedEngine()
	chat := "918884542333@s.whatsapp.net"
	inRange := time.Now().Add(-2 * time.Hour)
	outOfRange := time.Now().Add(-40 * 24 * time.Hour)

	e.parseWebMsgFn = func(c types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error) {
		return &events.Message{
			Info: types.MessageInfo{
				ID:            webMsg.GetKey().GetID(),
				Timestamp:     time.Unix(int64(webMsg.GetMessageTimestamp()), 0),
				MessageSource: types.MessageSource{Chat: c, Sender: c},
			},
			Message:      &waE2E.Message{Conversation: strp("hi")},
			SourceWebMsg: webMsg,
		}, nil
	}
	e.SetRange(protocol.Range7d)

	histMsg := func(id string, at time.Time) *waHistorySync.HistorySyncMsg {
		return &waHistorySync.HistorySyncMsg{Message: &waWeb.WebMessageInfo{
			Key:              &waCommon.MessageKey{ID: strp(id), RemoteJID: strp(chat)},
			MessageTimestamp: u64p(uint64(at.Unix())),
		}}
	}
	e.processHistorySync(&events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType:   waHistorySync.HistorySync_FULL.Enum(),
		ChunkOrder: u32p(3),
		Progress:   u32p(50),
		Conversations: []*waHistorySync.Conversation{
			{
				ID:               strp(chat),
				LastMsgTimestamp: u64p(uint64(inRange.Unix())),
				Messages:         []*waHistorySync.HistorySyncMsg{histMsg("OLD", outOfRange), histMsg("NEW", inRange)},
			},
			{
				// A whole conversation whose last activity is outside the range.
				ID:               strp("15550001111@s.whatsapp.net"),
				LastMsgTimestamp: u64p(uint64(outOfRange.Unix())),
				Messages:         []*waHistorySync.HistorySyncMsg{histMsg("STALE", outOfRange)},
			},
		},
	}})

	var ids []string
	for _, line := range decodeLines(t, buf) {
		if line["t"] != "event" {
			continue
		}
		ids = append(ids, line["event"].(map[string]any)["external_id"].(string))
	}
	if len(ids) != 1 || ids[0] != chat+"/NEW" {
		t.Fatalf("emitted %v, want only %s (range filtering must be unchanged)", ids, chat+"/NEW")
	}

	// The per-payload accounting line is what made the shallow-import incident
	// need a DB query to diagnose; it must report the shape of the payload.
	want := []string{"type=FULL", "chunk=3", "progress=50%", "convs=1/2 in-range", "msgs=2 seen", "1 emitted", "1 out-of-range"}
	for _, w := range want {
		if !strings.Contains(log.String(), w) {
			t.Fatalf("history-sync payload log missing %q; log=%q", w, log.String())
		}
	}
}
