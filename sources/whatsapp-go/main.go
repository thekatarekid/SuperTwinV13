// Command whatsapp-go is the SuperTwinV13 WhatsApp ingestion daemon.
//
// It speaks the NDJSON protocol defined in docs/PHASE1_CONTRACT.md over
// stdin (commands) and stdout (events). All human/diagnostic logging goes to
// stderr. It is READ-ONLY: there is NO code path that sends a WhatsApp message.
//
// Modes:
//   - default: connect to WhatsApp via whatsmeow (QR pairing + session store).
//   - --mock (or env SUPERTWIN_WHATSAPP_MOCK=1): replay a synthetic fixture
//     through the exact same protocol, with zero WhatsApp account, for CI.
//
// Flags: --session-db <path> --media-dir <path> --log-level <level>
//
//	--mock --fixture <path>
package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/daemon"
	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/mock"
	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/wa"
)

func main() {
	var (
		sessionDB   = flag.String("session-db", "", "path to the whatsmeow sqlstore session database")
		mediaDir    = flag.String("media-dir", "", "directory to write downloaded media into")
		logLevel    = flag.String("log-level", "info", "log level (debug|info|warn|error)")
		mockMode    = flag.Bool("mock", false, "run in mock mode (no WhatsApp connection; replay fixture)")
		fixturePath = flag.String("fixture", "", "path to a JSON fixture (mock mode only; defaults to built-in)")
	)
	flag.Parse()

	// Diagnostic logging -> stderr ONLY. Never stdout (protocol channel).
	logger := log.New(os.Stderr, "whatsapp-go ", log.LstdFlags|log.Lmsgprefix)
	logf := func(format string, args ...any) { logger.Printf(format, args...) }

	// Protocol writer over stdout (flushes each line).
	w := protocol.NewWriter(os.Stdout)

	isMock := *mockMode || os.Getenv("SUPERTWIN_WHATSAPP_MOCK") == "1"

	if *mediaDir == "" {
		fmt.Fprintln(os.Stderr, "whatsapp-go: --media-dir is required")
		os.Exit(2)
	}

	var engine daemon.Engine
	if isMock {
		logf("starting in MOCK mode (session-db=%s media-dir=%s)", *sessionDB, *mediaDir)
		fixture := mock.BuiltinFixture()
		if *fixturePath != "" {
			f, err := mock.LoadFixture(*fixturePath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "whatsapp-go: failed to load fixture %q: %v\n", *fixturePath, err)
				os.Exit(2)
			}
			fixture = f
			logf("loaded fixture from %s", *fixturePath)
		}
		engine = mock.New(w, logf, fixture, *mediaDir)
	} else {
		if *sessionDB == "" {
			fmt.Fprintln(os.Stderr, "whatsapp-go: --session-db is required (non-mock mode)")
			os.Exit(2)
		}
		logf("starting whatsmeow engine (session-db=%s media-dir=%s)", *sessionDB, *mediaDir)
		engine = wa.New(w, logf, *sessionDB, *mediaDir, *logLevel)
	}

	os.Exit(daemon.Run(engine, w, logf))
}
