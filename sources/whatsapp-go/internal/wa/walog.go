package wa

import (
	"fmt"
	"os"
	"strings"
	"time"

	waLog "go.mau.fi/whatsmeow/util/log"
)

// stderrLogger is a whatsmeow waLog.Logger that writes to STDERR. The built-in
// waLog.Stdout writes to stdout, which would corrupt our NDJSON protocol
// channel — so we must never use it. This mirrors its formatting on stderr.
type stderrLogger struct {
	mod string
	min int
}

var levelToInt = map[string]int{
	"":      -1,
	"DEBUG": 0,
	"INFO":  1,
	"WARN":  2,
	"ERROR": 3,
}

func newStderrLogger(module, minLevel string) waLog.Logger {
	return &stderrLogger{mod: module, min: levelToInt[strings.ToUpper(minLevel)]}
}

func (s *stderrLogger) outputf(level, msg string, args ...any) {
	if levelToInt[level] < s.min {
		return
	}
	fmt.Fprintf(os.Stderr, "%s [%s %s] %s\n",
		time.Now().Format("15:04:05.000"), s.mod, level, fmt.Sprintf(msg, args...))
}

func (s *stderrLogger) Errorf(msg string, args ...any) { s.outputf("ERROR", msg, args...) }
func (s *stderrLogger) Warnf(msg string, args ...any)  { s.outputf("WARN", msg, args...) }
func (s *stderrLogger) Infof(msg string, args ...any)  { s.outputf("INFO", msg, args...) }
func (s *stderrLogger) Debugf(msg string, args ...any) { s.outputf("DEBUG", msg, args...) }
func (s *stderrLogger) Sub(mod string) waLog.Logger {
	return &stderrLogger{mod: fmt.Sprintf("%s/%s", s.mod, mod), min: s.min}
}
