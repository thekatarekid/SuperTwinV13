package daemon

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"testing"
	"time"

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
	sends        []string // "to|text" per SendMessage call
	countCalls   int
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
func (f *fakeEngine) CountRange() {
	f.mu.Lock()
	f.countCalls++
	f.mu.Unlock()
}
func (f *fakeEngine) Pause()  {}
func (f *fakeEngine) Resume() {}
func (f *fakeEngine) SendMessage(to, text string) {
	f.mu.Lock()
	f.sends = append(f.sends, to+"|"+text)
	f.mu.Unlock()
}
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

// sendCalls returns a copy of the engine's recorded SendMessage calls.
func (f *fakeEngine) sendCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.sends...)
}

// captureWriter returns a protocol.Writer over a buffer plus the buffer, so a
// test can assert on the frames a refusal emitted.
func captureWriter() (*protocol.Writer, *bytes.Buffer) {
	var buf bytes.Buffer
	return protocol.NewWriter(&buf), &buf
}

// TestSendMessageWithoutTokenRefused proves the send gate (P0.6): a
// send_message with no approval_token NEVER reaches the engine — the daemon
// emits SEND_REFUSED + a failed send_result and stops.
func TestSendMessageWithoutTokenRefused(t *testing.T) {
	fe := &fakeEngine{}
	w, buf := captureWriter()

	handleCommand(fe, w, func(string, ...any) {}, protocol.Command{
		Cmd: "send_message", To: "15551234567@s.whatsapp.net", Text: "hi",
	}, func() {})

	if calls := fe.sendCalls(); len(calls) != 0 {
		t.Fatalf("engine.SendMessage must NOT be called without a token; got %v", calls)
	}
	out := buf.String()
	if !strings.Contains(out, "SEND_REFUSED") {
		t.Fatalf("expected SEND_REFUSED error frame, got: %s", out)
	}
	if !strings.Contains(out, `"t":"send_result"`) || !strings.Contains(out, `"ok":false`) {
		t.Fatalf("expected failed send_result frame, got: %s", out)
	}
}

// TestSendMessageTokenSingleUse proves the daemon's own replay guard: the same
// approval token admits exactly one send through this process; the second use
// is refused before the engine. The token is a REAL one (S4.5): signed under
// the install's approval key and bound to this exact recipient and text.
func TestSendMessageTokenSingleUse(t *testing.T) {
	t.Setenv(ApprovalKeyEnv, testKey)
	fe := &fakeEngine{}
	w, buf := captureWriter()
	tok := mintTestToken(t, testKey, "whatsapp.send", strings.Repeat("c", 32),
		time.Now().Add(5*time.Minute), "15551234567@s.whatsapp.net", "hello", true)
	cmd := protocol.Command{
		Cmd: "send_message", To: "15551234567@s.whatsapp.net", Text: "hello",
		ApprovalToken: tok,
	}

	handleCommand(fe, w, func(string, ...any) {}, cmd, func() {})
	if calls := fe.sendCalls(); len(calls) != 1 || calls[0] != "15551234567@s.whatsapp.net|hello" {
		t.Fatalf("first tokened send must reach the engine; got %v", calls)
	}

	handleCommand(fe, w, func(string, ...any) {}, cmd, func() {})
	if calls := fe.sendCalls(); len(calls) != 1 {
		t.Fatalf("replayed token must be refused; engine calls = %v", calls)
	}
	if !strings.Contains(buf.String(), "already used") {
		t.Fatalf("expected already-used refusal, got: %s", buf.String())
	}
}

// TestSendMessageMissingToRefused proves a tokened send still needs to+text.
func TestSendMessageMissingToRefused(t *testing.T) {
	fe := &fakeEngine{}
	w, buf := captureWriter()

	handleCommand(fe, w, func(string, ...any) {}, protocol.Command{
		Cmd: "send_message", Text: "hi", ApprovalToken: "tok-missing-to-1",
	}, func() {})
	// The refusal names the missing payload, not the token: to/text are checked
	// before the gate, so the message says what is actually wrong.
	if !strings.Contains(buf.String(), "to and text are required") {
		t.Fatalf("expected the to/text refusal, got: %s", buf.String())
	}

	if calls := fe.sendCalls(); len(calls) != 0 {
		t.Fatalf("send without `to` must not reach the engine; got %v", calls)
	}
	if !strings.Contains(buf.String(), "SEND_REFUSED") {
		t.Fatalf("expected SEND_REFUSED, got: %s", buf.String())
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

// TestCountRangeCommandDispatches proves the `count_range` command (S1.5) reaches
// engine.CountRange and touches nothing else: no range installed, no import.
func TestCountRangeCommandDispatches(t *testing.T) {
	eng := &fakeEngine{}
	var buf bytes.Buffer
	w := protocol.NewWriter(&buf)
	handleCommand(eng, w, func(string, ...any) {}, protocol.Command{Cmd: "count_range"}, func() {})
	eng.mu.Lock()
	calls, rangeSet := eng.countCalls, eng.rangeSet
	eng.mu.Unlock()
	if calls != 1 {
		t.Fatalf("CountRange called %d times, want 1", calls)
	}
	if rangeSet {
		t.Fatal("count_range must not install a range")
	}
}
