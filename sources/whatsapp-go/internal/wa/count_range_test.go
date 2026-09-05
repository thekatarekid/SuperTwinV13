package wa

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// histBatch builds one INITIAL_BOOTSTRAP-style HistorySync payload for a chat
// with messages at the given ages.
func histBatch(chat string, syncType waHistorySync.HistorySync_HistorySyncType, now time.Time, ages ...time.Duration) *events.HistorySync {
	var msgs []*waHistorySync.HistorySyncMsg
	var newest time.Time
	for i, age := range ages {
		at := now.Add(-age)
		if at.After(newest) {
			newest = at
		}
		msgs = append(msgs, &waHistorySync.HistorySyncMsg{Message: &waWeb.WebMessageInfo{
			Key:              &waCommon.MessageKey{ID: strp(chat + "-M" + string(rune('A'+i))), RemoteJID: strp(chat)},
			MessageTimestamp: u64p(uint64(at.Unix())),
		}})
	}
	return &events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: syncType.Enum(),
		Conversations: []*waHistorySync.Conversation{{
			ID:               strp(chat),
			LastMsgTimestamp: u64p(uint64(newest.Unix())),
			Messages:         msgs,
		}},
	}}
}

func rangeCountsFrames(t *testing.T, lines []map[string]any) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, l := range lines {
		if l["t"] == "range_counts" {
			out = append(out, l)
		}
	}
	return out
}

func countOf(t *testing.T, frame map[string]any, r string) (chats, msgs int) {
	t.Helper()
	counts := frame["counts"].(map[string]any)
	c, ok := counts[r].(map[string]any)
	if !ok {
		t.Fatalf("range_counts has no %q entry: %v", r, counts)
	}
	return int(c["chats"].(float64)), int(c["messages"].(float64))
}

// TestCountRangeMeasuresBufferedHistory (S1.5 / T4-7 / CNS-09 "events exact"):
// with NO range installed the post-pairing HistorySync sits in the buffer, and
// count_range still answers with measured per-window counts over it — with the
// caveat fields (buffered batches, sync types, oldest ts, no range installed).
func TestCountRangeMeasuresBufferedHistory(t *testing.T) {
	e, buf := newTestEngine()
	now := time.Now()
	day := 24 * time.Hour

	// Two chats: one active (2h, 5d, 40d old), one stale (10d, 12d old).
	e.onHistorySync(histBatch("15550001111@s.whatsapp.net", waHistorySync.HistorySync_INITIAL_BOOTSTRAP, now, 2*time.Hour, 5*day, 40*day))
	e.onHistorySync(histBatch("15550002222@s.whatsapp.net", waHistorySync.HistorySync_INITIAL_BOOTSTRAP, now, 10*day, 12*day))
	// Noise chats never count.
	e.onHistorySync(histBatch("status@broadcast", waHistorySync.HistorySync_INITIAL_BOOTSTRAP, now, time.Hour))

	e.mu.Lock()
	buffered := len(e.pendingHistory)
	e.mu.Unlock()
	if buffered != 3 {
		t.Fatalf("pendingHistory = %d, want 3 (no range installed: nothing processed)", buffered)
	}

	e.CountRange()
	frames := rangeCountsFrames(t, decodeLines(t, buf))
	if len(frames) != 1 {
		t.Fatalf("range_counts frames = %d, want 1", len(frames))
	}
	f := frames[0]
	type want struct{ chats, msgs int }
	wants := map[string]want{
		"24h": {1, 1}, "3d": {1, 1}, "7d": {1, 2}, "30d": {2, 4}, "90d": {2, 5}, "all": {2, 5},
	}
	for r, w := range wants {
		c, m := countOf(t, f, r)
		if c != w.chats || m != w.msgs {
			t.Errorf("counts[%s] = %d chats / %d msgs, want %d / %d", r, c, m, w.chats, w.msgs)
		}
	}
	if f["range_installed"] != false {
		t.Errorf("range_installed = %v, want false before confirm", f["range_installed"])
	}
	if int(f["buffered_batches"].(float64)) != 3 || int(f["batches"].(float64)) != 3 {
		t.Errorf("buffered_batches/batches = %v/%v, want 3/3", f["buffered_batches"], f["batches"])
	}
	st := f["sync_types"].([]any)
	if len(st) != 1 || st[0] != "INITIAL_BOOTSTRAP" {
		t.Errorf("sync_types = %v, want [INITIAL_BOOTSTRAP]", st)
	}
	if f["oldest_ts"] == nil || f["newest_ts"] == nil {
		t.Errorf("oldest_ts/newest_ts missing: %v", f)
	}
	if int(f["messages"].(float64)) != 5 || int(f["chats"].(float64)) != 2 {
		t.Errorf("totals = %v msgs / %v chats, want 5 / 2", f["messages"], f["chats"])
	}

	// Counting is read-only: nothing installed, nothing drained, no event frames.
	e.mu.Lock()
	have, stillBuffered := e.haveImport, len(e.pendingHistory)
	e.mu.Unlock()
	if have || stillBuffered != 3 {
		t.Fatalf("count_range must not install/drain: haveImport=%v pending=%d", have, stillBuffered)
	}
	for _, l := range decodeLines(t, buf) {
		if l["t"] == "event" {
			t.Fatal("count_range must emit no events")
		}
	}

	// A re-delivered message counts once; a later batch adds to the measure.
	e.onHistorySync(histBatch("15550001111@s.whatsapp.net", waHistorySync.HistorySync_FULL, now, 2*time.Hour, 5*day, 40*day))
	buf.Reset()
	e.CountRange()
	f = rangeCountsFrames(t, decodeLines(t, buf))[0]
	if _, m := countOf(t, f, "all"); m != 5 {
		t.Errorf("re-delivered messages counted twice: all=%d, want 5", m)
	}
	st = f["sync_types"].([]any)
	if len(st) != 2 || st[0] != "FULL" || st[1] != "INITIAL_BOOTSTRAP" {
		t.Errorf("sync_types = %v, want [FULL INITIAL_BOOTSTRAP]", st)
	}
}

// TestLiveHeldUntilRangeConfirmed (S1.5: no live ingest between pairing and
// confirm): a live message that arrives with no window installed is held — no
// event frame — and released, in order, the moment SetRange confirms one. After
// that, live flows straight through.
func TestLiveHeldUntilRangeConfirmed(t *testing.T) {
	e, buf := newTestEngine()
	peer := mustJID(t, "15550003333@s.whatsapp.net")
	live := func(id, text string) *events.Message {
		return &events.Message{
			Info:    types.MessageInfo{ID: id, Timestamp: time.Now(), MessageSource: types.MessageSource{Chat: peer, Sender: peer}},
			Message: &waE2E.Message{Conversation: strp(text)},
		}
	}

	e.onMessage(live("L1", "first"))
	e.onMessage(live("L2", "second"))
	for _, l := range decodeLines(t, buf) {
		if l["t"] == "event" {
			t.Fatalf("live message emitted before the window was confirmed: %v", l)
		}
	}
	e.CountRange()
	f := rangeCountsFrames(t, decodeLines(t, buf))[0]
	if int(f["pending_live"].(float64)) != 2 {
		t.Fatalf("pending_live = %v, want 2", f["pending_live"])
	}

	// Confirm: SetRange installs the window and releases the hold in order.
	buf.Reset()
	e.SetRange("7d")
	var ids []string
	for _, l := range decodeLines(t, buf) {
		if l["t"] == "event" {
			ids = append(ids, l["event"].(map[string]any)["external_id"].(string))
		}
	}
	if len(ids) != 2 || ids[0] != peer.String()+"/L1" || ids[1] != peer.String()+"/L2" {
		t.Fatalf("released live ids = %v, want [L1 L2] in arrival order", ids)
	}
	e.mu.Lock()
	held := len(e.pendingLive)
	e.mu.Unlock()
	if held != 0 {
		t.Fatalf("pendingLive after SetRange = %d, want 0", held)
	}

	// Post-confirm live goes straight through.
	buf.Reset()
	e.onMessage(live("L3", "third"))
	n := 0
	for _, l := range decodeLines(t, buf) {
		if l["t"] == "event" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("post-confirm live emitted %d events, want 1", n)
	}
}

// TestLiveHoldIsBounded: the hold drops its OLDEST message past maxPendingLive so
// a confirm card left open in a busy group cannot grow memory without limit.
func TestLiveHoldIsBounded(t *testing.T) {
	e, _ := newTestEngine()
	peer := mustJID(t, "15550004444@s.whatsapp.net")
	for i := 0; i < maxPendingLive+5; i++ {
		e.onMessage(&events.Message{
			Info:    types.MessageInfo{ID: "M" + string(rune(i)), MessageSource: types.MessageSource{Chat: peer, Sender: peer}},
			Message: &waE2E.Message{Conversation: strp("x")},
		})
	}
	e.mu.Lock()
	held := len(e.pendingLive)
	e.mu.Unlock()
	if held != maxPendingLive {
		t.Fatalf("pendingLive = %d, want the bound %d", held, maxPendingLive)
	}
}
