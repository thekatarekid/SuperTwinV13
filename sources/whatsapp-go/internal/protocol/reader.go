package protocol

import (
	"bufio"
	"encoding/json"
	"io"
)

// ReadCommands reads line-delimited JSON commands from r (typically os.Stdin)
// and invokes fn for each successfully decoded Command. Blank lines and lines
// that fail to decode are skipped (the daemon must tolerate garbage without
// crashing). It returns when r reaches EOF or errors.
func ReadCommands(r io.Reader, fn func(Command)) error {
	sc := bufio.NewScanner(r)
	// Allow generously large command lines.
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(trimSpace(line)) == 0 {
			continue
		}
		var cmd Command
		if err := json.Unmarshal(line, &cmd); err != nil {
			// Ignore malformed lines; forward-compat + robustness.
			continue
		}
		fn(cmd)
	}
	return sc.Err()
}

// DecodeCommand decodes a single JSON command line. Exposed for tests.
func DecodeCommand(line []byte) (Command, error) {
	var c Command
	err := json.Unmarshal(line, &c)
	return c, err
}

func trimSpace(b []byte) []byte {
	start := 0
	for start < len(b) && isSpace(b[start]) {
		start++
	}
	end := len(b)
	for end > start && isSpace(b[end-1]) {
		end--
	}
	return b[start:end]
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}
