package wa

import (
	"bytes"
	"context"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// countCompletions returns how many progress-done:true and backfill_complete
// lines the captured NDJSON contains, plus the last done-progress chats_done /
// chats_total seen. Used to assert quiet-window completion fires ONCE with
// chats_done < chats_total (contract §R7.2).
func countCompletions(t *testing.T, buf *bytes.Buffer) (doneProgress, complete, lastDone, lastTotal int) {
	t.Helper()
	for _, l := range decodeLines(t, buf) {
		switch l["t"] {
		case "progress":
			if d, _ := l["done"].(bool); d {
				doneProgress++
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

// openBackfillRun opens a backfill run on e the way Import/Extend do (via
// resetBackfill) and seeds a plateau: total in-range chats > chats actually
// delivered. It simulates ONE processed history-sync batch (noteHistoryBatch +
// state) so the quiet window can arm (contract §R7.2: "after at least one
// batch"). Returns the run number.
func openPlateauRun(e *Engine, r protocol.Range, done, total int) int {
	run := e.resetBackfill(r)
	// An automatic (bootstrap) batch arrived and was processed: some chats
	// delivered, one or more didn't.
	e.noteHistoryBatch(false)
	e.backfill.mu.Lock()
	e.backfill.chatsTotal = total
	for i := 0; i < done; i++ {
		e.backfill.chatsDone[string(rune('a'+i))+"@s.whatsapp.net"] = true
	}
	e.backfill.mu.Unlock()
	return run
}

// TestQuietWindowCompletesWhenChatsPlateau is the core contract §R7.2 proof for
// the real engine: on a large import where WhatsApp never delivers history for
// some in-range chats, chats_done plateaus BELOW chats_total and the server
// never reports ~100% — yet the quiet-window watcher still fires
// progress done:true + backfill_complete once the batches stop arriving, so the
// banner clears. chats_done < chats_total in the terminal frame.
func TestQuietWindowCompletesWhenChatsPlateau(t *testing.T) {
	e, buf := newTestEngine()
	e.quietWindow = 40 * time.Millisecond // short window: no real ~11s wait.
	completed := watchCompletion(e)

	const (
		delivered = 2
		total     = 3 // one phantom chat never delivers -> plateau at 2/3.
	)
	run := openPlateauRun(e, protocol.Range24h, delivered, total)

	// Start the watcher exactly as Import does and wait for it to fire.
	go e.watchQuietCompletion(run, protocol.Range24h)

	awaitCompletion(t, completed, 2*time.Second)

	doneProgress, complete, lastDone, lastTotal := countCompletions(t, buf)
	if doneProgress < 1 {
		t.Fatal("quiet window must emit a progress done:true frame so the banner clears (contract §R7.2)")
	}
	if complete != 1 {
		t.Fatalf("backfill_complete fired %d times, want exactly 1 (once-only guard)", complete)
	}
	if lastDone != delivered || lastTotal != total {
		t.Fatalf("terminal done frame = %d/%d, want %d/%d (chats_done must plateau BELOW chats_total)", lastDone, lastTotal, delivered, total)
	}
	if lastDone >= lastTotal {
		t.Fatalf("contract §R7.2: completion must fire with chats_done (%d) < chats_total (%d)", lastDone, lastTotal)
	}
}

// TestQuietWindowFiresExactlyOnce proves the once-only guard (contract §R7.2):
// after the quiet watcher completes a run, a LATER completion attempt from
// another source (e.g. a delayed server-progress≥100 batch or the paginator
// settling) does NOT emit a second backfill_complete.
func TestQuietWindowFiresExactlyOnce(t *testing.T) {
	e, buf := newTestEngine()
	e.quietWindow = 40 * time.Millisecond
	completed := watchCompletion(e)

	run := openPlateauRun(e, protocol.Range24h, 1, 4)
	go e.watchQuietCompletion(run, protocol.Range24h)
	awaitCompletion(t, completed, 2*time.Second)

	// A stale/late completion attempt for the SAME run must be a no-op now that
	// the run is closed (idempotent finishBackfill).
	if e.finishBackfill(run, protocol.Range24h, 1, 4, 0) {
		t.Fatal("finishBackfill must return false after the run is already complete")
	}
	// Simulate a late blocking batch reporting server-complete: also a no-op.
	e.maybeCompleteBackfill(&events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_FULL.Enum(),
		Progress: u32p(100),
	}}, protocol.Range24h)

	_, complete, _, _ := countCompletions(t, buf)
	if complete != 1 {
		t.Fatalf("backfill_complete fired %d times across quiet + late attempts, want exactly 1", complete)
	}
}

// TestServerProgressCompletesRunOnce proves the server-progress path: a blocking
// history sync reporting ~100% completes the run once, and a subsequent quiet
// tick does NOT double-fire (both routed through the once-only finishBackfill).
func TestServerProgressCompletesRunOnce(t *testing.T) {
	e, buf := newTestEngine()
	e.quietWindow = 30 * time.Millisecond
	completed := watchCompletion(e)

	run := e.resetBackfill(protocol.Range7d)
	e.noteHistoryBatch(false)
	e.backfill.mu.Lock()
	e.backfill.chatsTotal = 5
	e.backfill.chatsDone["x@s.whatsapp.net"] = true // only 1/5 delivered so far.
	e.backfill.mu.Unlock()

	// Start the quiet watcher too, to prove it won't also fire.
	go e.watchQuietCompletion(run, protocol.Range7d)

	// Server reports (near) full progress -> complete now, even though done(1) <
	// total(5). This is the R6.3 server-complete path.
	e.maybeCompleteBackfill(&events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_RECENT.Enum(),
		Progress: u32p(99),
	}}, protocol.Range7d)

	awaitCompletion(t, completed, 2*time.Second)
	// Give the quiet ticker time to fire a (would-be duplicate) completion; it
	// must find the run already closed and exit without a second emit.
	time.Sleep(120 * time.Millisecond)

	doneProgress, complete, lastDone, lastTotal := countCompletions(t, buf)
	if doneProgress < 1 {
		t.Fatal("server-progress≥~100 must emit a progress done:true frame")
	}
	if complete != 1 {
		t.Fatalf("backfill_complete fired %d times (server-progress + quiet tick), want exactly 1", complete)
	}
	if lastDone != 1 || lastTotal != 5 {
		t.Fatalf("terminal frame = %d/%d, want 1/5 (server-complete fires regardless of done<total)", lastDone, lastTotal)
	}
}

// TestQuietWindowDoesNotArmWithoutABatch proves the quiet window only arms AFTER
// at least one history-sync batch (contract §R7.2): with zero batches processed,
// the watcher must NOT fire (an import that never receives any history must not
// spuriously "complete" from the timer alone).
func TestQuietWindowDoesNotArmWithoutABatch(t *testing.T) {
	e, buf := newTestEngine()
	e.quietWindow = 30 * time.Millisecond

	run := e.resetBackfill(protocol.Range24h) // open run, but NO noteHistoryBatch.
	ctx, cancel := context.WithCancel(context.Background())
	e.ctx = ctx
	go e.watchQuietCompletion(run, protocol.Range24h)

	time.Sleep(150 * time.Millisecond) // several quiet ticks pass.
	cancel()                           // stop the watcher.

	e.backfill.mu.Lock()
	active := e.backfill.active
	e.backfill.mu.Unlock()
	if !active {
		t.Fatal("quiet window must NOT complete a run that received zero history-sync batches (contract §R7.2)")
	}
	_, complete, _, _ := countCompletions(t, buf)
	if complete != 0 {
		t.Fatalf("no backfill_complete may fire before any batch arrives, got %d", complete)
	}
}

// watchCompletion installs the onBackfillDone hook and returns a channel that
// receives the completed run number AFTER finishBackfill has emitted the
// terminal frames. Awaiting it (rather than polling backfill.active) guarantees
// the writer emit finished before the test reads the buffer — no data race on
// the NDJSON buffer with the async watcher goroutine.
func watchCompletion(e *Engine) <-chan int {
	ch := make(chan int, 4)
	e.onBackfillDone = func(run int) { ch <- run }
	return ch
}

// awaitCompletion blocks until a completion is signaled or the deadline elapses.
func awaitCompletion(t *testing.T, ch <-chan int, d time.Duration) int {
	t.Helper()
	select {
	case run := <-ch:
		return run
	case <-time.After(d):
		t.Fatal("backfill run did not complete within deadline")
		return 0
	}
}

func u32p(v uint32) *uint32 { return &v }
