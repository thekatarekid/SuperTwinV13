package mock

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// 1x1 transparent PNG (used when a fixture media entry supplies no bytes).
var placeholderPNG = mustB64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

func mustB64(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// Engine is the mock backend implementing daemon.Engine. It replays a fixture
// through the real protocol Writer, applying the contract §4 range filters.
type Engine struct {
	w        *protocol.Writer
	logf     func(string, ...any)
	fixture  *Fixture
	mediaDir string

	mu        sync.Mutex
	paused    bool
	paired    bool
	widest    protocol.Range // widest range already emitted (for extend semantics)
	haveRange bool
	sendSeq   int // monotonically numbers mock send echoes (P0.6)

	// quietWindow simulates the real daemon's no-new-history-sync-batch idle
	// period (contract §R7.2) for the plateau case: when the fixture declares
	// in-range chats that deliver NO messages (Fixture.EmptyInRangeChats),
	// chats_done plateaus below chats_total, and after this window elapses the
	// mock fires done:true anyway. Kept short so tests need no real 11s sleep;
	// overridable via WithQuietWindow.
	quietWindow time.Duration
}

// New creates a mock Engine.
func New(w *protocol.Writer, logf func(string, ...any), fixture *Fixture, mediaDir string) *Engine {
	return &Engine{w: w, logf: logf, fixture: fixture, mediaDir: mediaDir, quietWindow: mockDefaultQuietWindow}
}

// WithQuietWindow overrides the simulated quiet-completion window (contract
// §R7.2). Tests use a tiny window so the plateau completion fires promptly
// without a real ~11s wait.
func (e *Engine) WithQuietWindow(d time.Duration) *Engine {
	e.mu.Lock()
	e.quietWindow = d
	e.mu.Unlock()
	return e
}

// mockDefaultQuietWindow is the mock's default simulated quiet window. It is
// short (not the real ~11s) so the default mock daemon still completes a
// plateau import quickly; tests may shorten it further via WithQuietWindow.
const mockDefaultQuietWindow = 500 * time.Millisecond

// Start emits ready + initial status. In mock mode there is no persisted
// session, so we advertise need_pairing until start_pairing is issued.
func (e *Engine) Start(ctx context.Context) error {
	if err := e.w.Ready(); err != nil {
		return err
	}
	return e.w.Status(protocol.StateNeedPairing, "mock mode: awaiting pairing", "", "")
}

// StartPairing emits a couple of fake QR codes then a fake paired event.
func (e *Engine) StartPairing() {
	e.mu.Lock()
	already := e.paired
	e.mu.Unlock()
	if already {
		_ = e.w.Status(protocol.StateOnline, "already paired (mock)", e.fixture.selfActorJID(), "You")
		return
	}
	_ = e.w.Status(protocol.StatePairing, "mock pairing", "", "")
	for i := 0; i < 2; i++ {
		_ = e.w.QR(fmt.Sprintf("2@mockqr-code-%d,mock,mock,mock", i), 60)
		time.Sleep(50 * time.Millisecond)
	}
	self := e.fixture.selfActorJID()
	e.mu.Lock()
	e.paired = true
	e.mu.Unlock()
	_ = e.w.Paired(self, "You")
	_ = e.w.Status(protocol.StateOnline, "mock online", self, "You")
}

// Import runs a range-filtered backfill from the fixture.
func (e *Engine) Import(r protocol.Range) {
	e.runBackfill(r, false)
	e.mu.Lock()
	e.widest = r
	e.haveRange = true
	e.mu.Unlock()
	// Continue "live": emit a live-phase progress marker.
	_ = e.w.Progress("live", 0, 0, 0, false, r)
}

// SetRange installs the active range WITHOUT running a backfill, mirroring the
// real engine (contract §4). The daemon dispatches `set_range` here; the mock
// records it as the widest range so a subsequent Extend to the same range is a
// no-op, but emits nothing (no run, no progress).
func (e *Engine) SetRange(r protocol.Range) {
	e.mu.Lock()
	e.widest = r
	e.haveRange = true
	e.mu.Unlock()
}

// SeedAnchors is a no-op for the mock: it replays a fixture rather than
// paginating WhatsApp, so it has no back-pagination anchors to restore. Recorded
// in the log only, so a worker sending the command against a mock daemon is
// visible rather than silently ignored.
func (e *Engine) SeedAnchors(anchors []protocol.Anchor) {
	e.logf("mock: ignoring seed_anchors (%d anchors; fixture replay has no paginator)", len(anchors))
}

// Extend widens coverage. In the mock, "all" is the widest possible, so extend
// simply re-runs the plan for the requested (wider) range. Overlaps are fine —
// the worker dedupes. We guard against re-running the identical range.
func (e *Engine) Extend(r protocol.Range) {
	e.mu.Lock()
	prev := e.widest
	have := e.haveRange
	e.mu.Unlock()
	if have && prev == r {
		// Nothing wider requested; emit an empty completion to avoid loops.
		_ = e.w.BackfillComplete(r, 0, 0)
		return
	}
	e.runBackfill(r, true)
	e.mu.Lock()
	e.widest = r
	e.haveRange = true
	e.mu.Unlock()
}

// runBackfill emits channel/actor/event/progress/backfill_complete for a range.
func (e *Engine) runBackfill(r protocol.Range, extend bool) {
	e.mu.Lock()
	if e.paused {
		e.mu.Unlock()
		e.logf("mock: import while paused; skipping emission")
		_ = e.w.BackfillComplete(r, 0, 0)
		return
	}
	e.mu.Unlock()

	now := time.Now()
	plan := e.fixture.BuildPlan(r, now)

	_ = e.w.Status(protocol.StateSyncing, "mock backfill", "", "")

	// Emit channels + actors up front (contract ordering guarantee).
	for _, c := range plan.Channels {
		_ = e.w.Channel(c)
	}
	for _, a := range plan.Actors {
		_ = e.w.Actor(a)
	}

	// chats_total = the in-range chats that DELIVER messages PLUS any phantom
	// in-range chats that deliver none (contract §R7.2). With phantoms, chats_done
	// (delivered chats) PLATEAUS below chats_total, exactly like a large/entire
	// real import where WhatsApp never pushes history for inactive chats.
	deliveredChats := len(plan.Channels)
	chatsTotal := deliveredChats + e.phantomInRangeChats()

	// Group events per chat to drive chats_done progress.
	seenChats := map[string]bool{}
	messages := 0
	for _, pe := range plan.Events {
		ev := e.buildEvent(pe)
		_ = e.w.Event(ev)
		messages++
		if !seenChats[pe.Msg.ChatJID] {
			seenChats[pe.Msg.ChatJID] = true
		}
		_ = e.w.Progress("backfill", len(seenChats), chatsTotal, messages, false, r)
	}

	// Completion (contract §R7.2). If every in-range chat delivered (chatsDone ==
	// chatsTotal), fire done immediately. Otherwise chats_done has PLATEAUED below
	// chats_total — the delivered chats are done but the phantom chats never will
	// be — so simulate the quiet window (no new history-sync batch) elapsing and
	// then fire done ANYWAY, leaving chats_done < chats_total. The banner clears.
	chatsDone := len(seenChats)
	if chatsDone < chatsTotal {
		e.sleepQuietWindow()
		e.logf("mock: import completed via quiet window with %d/%d chats (plateau; contract §R7.2)", chatsDone, chatsTotal)
	}
	_ = e.w.Progress("backfill", chatsDone, chatsTotal, messages, true, r)
	_ = e.w.BackfillComplete(r, chatsDone, messages)
	_ = e.w.Status(protocol.StateOnline, "mock online", e.fixture.selfActorJID(), "You")
}

// phantomInRangeChats returns the fixture's declared count of in-range chats
// that deliver no messages (contract §R7.2). These inflate chats_total so a mock
// import can reproduce the real plateau where chats_done < chats_total forever.
func (e *Engine) phantomInRangeChats() int {
	if e.fixture == nil || e.fixture.EmptyInRangeChats < 0 {
		return 0
	}
	return e.fixture.EmptyInRangeChats
}

// sleepQuietWindow waits the simulated quiet window (contract §R7.2). Kept short
// (mockDefaultQuietWindow, or a tiny value via WithQuietWindow in tests) so the
// mock never blocks on a real ~11s wait.
func (e *Engine) sleepQuietWindow() {
	e.mu.Lock()
	d := e.quietWindow
	e.mu.Unlock()
	if d <= 0 {
		d = mockDefaultQuietWindow
	}
	time.Sleep(d)
}

// buildEvent converts a planned fixture message to a protocol.Event, writing
// any media file to disk. Every planned event is a REPLAY — the mock has no live
// socket — so they carry the same historical marking a real import does
// (v4-spec §4b); a mock that emitted them as live arrivals would let the worker
// validate a batching path production never takes.
func (e *Engine) buildEvent(pe PlannedEvent) protocol.Event {
	m := pe.Msg
	ev := protocol.Event{
		ExternalID:   m.ChatJID + "/" + m.MessageID,
		ChannelExtID: m.ChatJID,
		ActorExtID:   m.SenderJID,
		TS:           protocol.FormatTime(pe.TS),
		Kind:         protocol.Kind(m.Kind),
		Text:         m.Text,
		FromMe:       m.FromMe,
		IsHistorical: true,
		Raw: map[string]any{
			"id":        m.MessageID,
			"chat":      m.ChatJID,
			"sender":    m.SenderJID,
			"type":      m.Kind,
			"timestamp": protocol.FormatTime(pe.TS),
		},
	}
	// Reaction target ref (contract §R5.3) and quoted-reply ref (contract §R5.4)
	// pass through verbatim so the worker↔UI pipeline can be exercised end-to-end.
	if m.ReplyToExternalID != "" {
		ev.ReplyToExternalID = m.ReplyToExternalID
	}
	if len(m.MentionedExtIDs) > 0 {
		ev.MentionedExtIDs = append([]string(nil), m.MentionedExtIDs...)
	}
	if m.ReplyTo != nil {
		ev.ReplyTo = &protocol.ReplyTo{
			ExternalID: m.ReplyTo.ExternalID,
			Text:       m.ReplyTo.Text,
			ActorExtID: m.ReplyTo.ActorExtID,
		}
	}
	if m.Media != nil {
		if md, err := e.writeMedia(m); err != nil {
			e.logf("mock: failed to write media for %s: %v", m.MessageID, err)
		} else {
			ev.Media = md
		}
	}
	return ev
}

// writeMedia materializes a fixture media file under mediaDir/<chatJID>/<msgID>.<ext>.
func (e *Engine) writeMedia(m FixtureMessage) (*protocol.Media, error) {
	dir := filepath.Join(e.mediaDir, m.ChatJID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	ext := m.Media.Ext
	if ext == "" {
		ext = "bin"
	}
	path := filepath.Join(dir, m.MessageID+"."+ext)

	var data []byte
	if m.Media.BytesB64 != "" {
		b, err := base64.StdEncoding.DecodeString(m.Media.BytesB64)
		if err != nil {
			return nil, err
		}
		data = b
	} else {
		data = placeholderPNG
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	filename := m.Media.Filename
	if filename == "" {
		filename = m.MessageID + "." + ext
	}
	return &protocol.Media{
		Path:     path,
		Mime:     m.Media.Mime,
		Filename: filename,
		Size:     int64(len(data)),
		SHA256:   hex.EncodeToString(sum[:]),
	}, nil
}

// SendMessage emits the echo of one approved send (P0.6). The daemon's
// approval-token gate ran BEFORE this is called; the mock adds two refusals of
// its own: an unpaired session cannot send, and a fixture with refuse_sends
// (the send-refusal fixture) refuses every send so CI can exercise the
// worker's refusal path end to end.
func (e *Engine) SendMessage(to, text string) {
	e.mu.Lock()
	paired := e.paired
	refuse := e.fixture != nil && e.fixture.RefuseSends
	e.sendSeq++
	seq := e.sendSeq
	e.mu.Unlock()

	if refuse {
		e.logf("mock: refusing send_message to %s (refuse_sends fixture)", to)
		_ = e.w.Error("SEND_REFUSED", "mock fixture refuses sends", false)
		_ = e.w.SendResult(false, "", "mock fixture refuses sends")
		return
	}
	if !paired {
		e.logf("mock: send_message while unpaired")
		_ = e.w.Error("SEND_FAILED", "not paired", false)
		_ = e.w.SendResult(false, "", "not paired")
		return
	}

	now := time.Now()
	id := fmt.Sprintf("MOCKSEND%04d", seq)
	ext := to + "/" + id
	self := e.fixture.selfActorJID()
	_ = e.w.Event(protocol.Event{
		ExternalID:   ext,
		ChannelExtID: to,
		ActorExtID:   self,
		TS:           protocol.FormatTime(now),
		Kind:         protocol.KindMessage,
		Text:         text,
		FromMe:       true,
		Raw: map[string]any{
			"id":        id,
			"chat":      to,
			"sender":    self,
			"type":      "message",
			"timestamp": protocol.FormatTime(now),
		},
	})
	_ = e.w.SendResult(true, ext, "")
	e.logf("mock: sent message %s", ext)
}

// Pause halts emission.
func (e *Engine) Pause() {
	e.mu.Lock()
	e.paused = true
	e.mu.Unlock()
	_ = e.w.Status(protocol.StateOnline, "paused (mock)", "", "")
	e.logf("mock: paused")
}

// Resume resumes emission.
func (e *Engine) Resume() {
	e.mu.Lock()
	e.paused = false
	e.mu.Unlock()
	_ = e.w.Status(protocol.StateOnline, "resumed (mock)", "", "")
	e.logf("mock: resumed")
}

// Logout clears the (mock) session state.
func (e *Engine) Logout() {
	e.mu.Lock()
	e.paired = false
	e.widest = ""
	e.haveRange = false
	e.mu.Unlock()
	_ = e.w.Status(protocol.StateLoggedOut, "logged out (mock)", "", "")
	e.logf("mock: logged out")
}

// Shutdown is a no-op for the mock (no external resources).
func (e *Engine) Shutdown() {
	e.logf("mock: shutdown")
}
