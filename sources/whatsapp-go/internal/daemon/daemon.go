// Package daemon wires the stdin command loop, the process lifecycle
// (signals, shutdown), and an Engine (real whatsmeow or mock) to the NDJSON
// protocol Writer. It is engine-agnostic: both the real and mock backends
// implement Engine.
package daemon

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// Engine is the backend abstraction. The real whatsmeow client and the mock
// fixture runner both implement it. All methods must be non-blocking or
// internally goroutine-managed; the daemon calls them from the command loop.
type Engine interface {
	// Start opens the session store / prepares the backend and emits `ready`
	// plus the initial status. For an existing session it should auto-connect
	// toward `online`. ctx is cancelled on shutdown.
	Start(ctx context.Context) error
	// StartPairing begins QR pairing (or no-ops + status online if paired).
	StartPairing()
	// Import runs a range-limited backfill, then continues live.
	Import(r protocol.Range)
	// Extend requests older history to widen coverage.
	Extend(r protocol.Range)
	// SetRange installs the active import range WITHOUT starting a run. The worker
	// sends `set_range` at connect (before WhatsApp pushes its automatic
	// post-pairing HistorySync) so pushed history is filtered to the intended
	// range instead of flooding all history.
	SetRange(r protocol.Range)
	// Pause halts event emission.
	Pause()
	// Resume resumes event emission.
	Resume()
	// Logout fully clears the session (unpair) and emits `status logged_out`.
	// After it returns, the daemon exits 0 so the supervising worker restarts a
	// FRESH process with no session -> need_pairing -> qr on start_pairing
	// (contract §R3.1). Logout must therefore be synchronous: finish clearing +
	// emitting before returning.
	Logout()
	// Shutdown flushes and releases resources. Must return within the deadline
	// the caller enforces.
	Shutdown()
}

// Config holds the resolved runtime configuration.
type Config struct {
	SessionDB string
	MediaDir  string
	LogLevel  string
}

// Run executes the daemon: it starts the engine, spawns the stdin command
// loop, installs signal handlers, and blocks until shutdown. It returns the
// process exit code.
func Run(engine Engine, w *protocol.Writer, logf func(string, ...any)) int {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := engine.Start(ctx); err != nil {
		_ = w.Error("start_failed", err.Error(), true)
		logf("engine start failed: %v", err)
		return 1
	}

	// Signal handling: SIGTERM/SIGINT trigger the same clean shutdown as the
	// `shutdown` command.
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	done := make(chan struct{})

	// stdin command loop.
	go func() {
		defer close(done)
		_ = protocol.ReadCommands(os.Stdin, func(cmd protocol.Command) {
			handleCommand(engine, w, logf, cmd, cancel)
		})
		// stdin closed (EOF): the worker went away. Treat as shutdown.
		logf("stdin closed (EOF); shutting down")
	}()

	select {
	case sig := <-sigCh:
		logf("received signal %v; shutting down", sig)
	case <-done:
		// stdin EOF path.
	case <-ctx.Done():
		// `shutdown` command cancelled the context.
	}

	// Perform a bounded graceful shutdown (~3s per contract).
	shutdownWithDeadline(engine, logf, 3*time.Second)
	return 0
}

// handleCommand dispatches a single worker->daemon command. Unknown commands
// are ignored (contract §2).
func handleCommand(engine Engine, w *protocol.Writer, logf func(string, ...any), cmd protocol.Command, cancel context.CancelFunc) {
	switch cmd.Cmd {
	case "start_pairing":
		engine.StartPairing()
	case "import":
		engine.Import(cmd.Range)
	case "extend":
		engine.Extend(cmd.Range)
	case "set_range":
		// Install the range without starting a run (contract §4). The worker sends
		// this at connect so the automatic post-pairing HistorySync is filtered to
		// the intended range instead of flooding all history.
		engine.SetRange(cmd.Range)
	case "pause":
		engine.Pause()
	case "resume":
		engine.Resume()
	case "logout":
		// Clear the whatsmeow session + emit `logged_out` synchronously, then take
		// the clean-exit path: cancel the context so Run() unwinds and returns 0.
		// A fresh daemon (no session) reliably re-pairs (contract §R3.1).
		engine.Logout()
		logf("logout complete; exiting for a fresh restart")
		cancel()
	case "shutdown":
		logf("received shutdown command")
		cancel()
	default:
		logf("ignoring unknown command %q", cmd.Cmd)
	}
}

// shutdownWithDeadline runs engine.Shutdown but never blocks longer than d.
func shutdownWithDeadline(engine Engine, logf func(string, ...any), d time.Duration) {
	finished := make(chan struct{})
	go func() {
		engine.Shutdown()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(d):
		logf("shutdown deadline (%s) exceeded; exiting anyway", d)
	}
}
