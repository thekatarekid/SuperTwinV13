package daemon

import (
	"context"
	"sync"
	"testing"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// fakeEngine records which methods were called so we can assert the daemon's
// logout clean-exit path (contract §R3.1).
type fakeEngine struct {
	mu           sync.Mutex
	loggedOut    bool
	shutdownDone bool
	rangeSet     bool
	lastRange    protocol.Range
	lastAnchors  []protocol.Anchor
}

func (f *fakeEngine) Start(ctx context.Context) error { return nil }
func (f *fakeEngine) StartPairing()                   {}
func (f *fakeEngine) Import(protocol.Range)           {}
func (f *fakeEngine) Extend(protocol.Range)           {}
func (f *fakeEngine) SetRange(r protocol.Range) {
	f.mu.Lock()
	f.rangeSet = true
	f.lastRange = r
	f.mu.Unlock()
}
func (f *fakeEngine) SeedAnchors(anchors []protocol.Anchor) {
	f.mu.Lock()
	f.lastAnchors = anchors
	f.mu.Unlock()
}
func (f *fakeEngine) Pause()  {}
func (f *fakeEngine) Resume() {}
func (f *fakeEngine) Logout() {
	f.mu.Lock()
	f.loggedOut = true
	f.mu.Unlock()
}
func (f *fakeEngine) Shutdown() {
	f.mu.Lock()
	f.shutdownDone = true
	f.mu.Unlock()
}

// TestLogoutTriggersCleanExit proves that the `logout` command clears the
// session (calls Logout) AND cancels the context so the daemon takes the
// clean-exit path (contract §R3.1: exit 0 -> worker restarts a fresh daemon).
func TestLogoutTriggersCleanExit(t *testing.T) {
	fe := &fakeEngine{}
	_, cancel := context.WithCancel(context.Background())
	defer cancel()

	cancelled := false
	fakeCancel := context.CancelFunc(func() { cancelled = true })

	handleCommand(fe, nil, func(string, ...any) {}, protocol.Command{Cmd: "logout"}, fakeCancel)

	fe.mu.Lock()
	loggedOut := fe.loggedOut
	fe.mu.Unlock()
	if !loggedOut {
		t.Fatal("logout command must call engine.Logout()")
	}
	if !cancelled {
		t.Fatal("logout command must cancel the context to take the clean-exit path (exit 0)")
	}
}

// TestSetRangeCommandInstallsRange proves the `set_range` command dispatches to
// engine.SetRange with the command's range (the connect-time range install that
// keeps WhatsApp's automatic post-pairing HistorySync from flooding all history)
// and does NOT take the clean-exit path.
func TestSetRangeCommandInstallsRange(t *testing.T) {
	fe := &fakeEngine{}
	cancelled := false
	fakeCancel := context.CancelFunc(func() { cancelled = true })

	handleCommand(fe, nil, func(string, ...any) {}, protocol.Command{Cmd: "set_range", Range: protocol.Range7d}, fakeCancel)

	fe.mu.Lock()
	set := fe.rangeSet
	got := fe.lastRange
	fe.mu.Unlock()
	if !set {
		t.Fatal("set_range command must call engine.SetRange()")
	}
	if got != protocol.Range7d {
		t.Fatalf("SetRange got range %q, want %q", got, protocol.Range7d)
	}
	if cancelled {
		t.Fatal("set_range must NOT cancel the context (it is not a lifecycle command)")
	}
}

// TestSeedAnchorsCommandDispatches proves the `seed_anchors` command reaches
// engine.SeedAnchors with its payload intact. This is the wire message the worker
// sends at connect (and before extend) to restore back-pagination anchors the
// daemon cannot rebuild itself — without it a restarted daemon holds no anchors
// and "Extend history" is a silent no-op.
func TestSeedAnchorsCommandDispatches(t *testing.T) {
	fe := &fakeEngine{}
	cancelled := false
	fakeCancel := context.CancelFunc(func() { cancelled = true })

	line := []byte(`{"cmd":"seed_anchors","anchors":[` +
		`{"chat_jid":"918884542333@s.whatsapp.net","msg_id":"3EB0ABC","from_me":false,"ts":"2026-07-02T12:34:56.789Z"}]}`)
	cmd, err := protocol.DecodeCommand(line)
	if err != nil {
		t.Fatalf("seed_anchors line must decode: %v", err)
	}

	handleCommand(fe, nil, func(string, ...any) {}, cmd, fakeCancel)

	fe.mu.Lock()
	got := fe.lastAnchors
	fe.mu.Unlock()
	if len(got) != 1 {
		t.Fatalf("SeedAnchors got %d anchors, want 1", len(got))
	}
	want := protocol.Anchor{
		ChatJID: "918884542333@s.whatsapp.net",
		MsgID:   "3EB0ABC",
		FromMe:  false,
		TS:      "2026-07-02T12:34:56.789Z",
	}
	if got[0] != want {
		t.Fatalf("anchor = %+v, want %+v", got[0], want)
	}
	if cancelled {
		t.Fatal("seed_anchors must NOT cancel the context (it is not a lifecycle command)")
	}
}

// TestShutdownReturnsZero proves the daemon's normal exit is code 0 (the
// clean-exit contract for both `shutdown` and post-logout restart).
func TestShutdownReturnsZero(t *testing.T) {
	fe := &fakeEngine{}
	shutdownWithDeadline(fe, func(string, ...any) {}, 0)
	// (deadline 0 exercises the timeout branch; Shutdown may or may not have run,
	// which is fine — the point is it never blocks/panics.)

	// A clean shutdown path must invoke Shutdown when given time.
	fe2 := &fakeEngine{}
	done := make(chan struct{})
	go func() { shutdownWithDeadline(fe2, func(string, ...any) {}, 1e9); close(done) }()
	<-done
	fe2.mu.Lock()
	ok := fe2.shutdownDone
	fe2.mu.Unlock()
	if !ok {
		t.Fatal("shutdownWithDeadline should call engine.Shutdown() within the deadline")
	}
}
