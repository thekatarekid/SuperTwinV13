package protocol

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// Writer serializes protocol messages to an underlying writer (stdout),
// one JSON object per line, flushing after every line so the worker never
// waits on a buffered line. It is safe for concurrent use.
type Writer struct {
	mu sync.Mutex
	bw *bufio.Writer
}

// NewWriter wraps w (typically os.Stdout).
func NewWriter(w io.Writer) *Writer {
	return &Writer{bw: bufio.NewWriter(w)}
}

// emit marshals v, writes it followed by a newline, and flushes.
func (w *Writer) emit(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, err := w.bw.Write(b); err != nil {
		return err
	}
	if err := w.bw.WriteByte('\n'); err != nil {
		return err
	}
	return w.bw.Flush()
}

func (w *Writer) Ready() error {
	return w.emit(readyMsg{T: "ready"})
}

func (w *Writer) Status(state State, detail, jid, pushName string) error {
	return w.emit(statusMsg{T: "status", State: state, Detail: detail, JID: jid, PushName: pushName})
}

func (w *Writer) QR(code string, timeoutS int) error {
	return w.emit(qrMsg{T: "qr", Code: code, TimeoutS: timeoutS})
}

func (w *Writer) Paired(jid, pushName string) error {
	return w.emit(pairedMsg{T: "paired", JID: jid, PushName: pushName})
}

func (w *Writer) Channel(c Channel) error {
	return w.emit(channelMsg{T: "channel", Channel: c})
}

func (w *Writer) Actor(a Actor) error {
	return w.emit(actorMsg{T: "actor", Actor: a})
}

func (w *Writer) Event(e Event) error {
	return w.emit(eventMsg{T: "event", Event: e})
}

func (w *Writer) Progress(phase string, chatsDone, chatsTotal, messages int, done bool, r Range) error {
	return w.emit(progressMsg{
		T: "progress", Phase: phase, ChatsDone: chatsDone, ChatsTotal: chatsTotal,
		Messages: messages, Done: done, Range: r,
	})
}

func (w *Writer) BackfillComplete(r Range, chats, messages int) error {
	return w.emit(backfillCompleteMsg{T: "backfill_complete", Range: r, Chats: chats, Messages: messages})
}

func (w *Writer) Error(code, message string, fatal bool) error {
	return w.emit(errorMsg{T: "error", Code: code, Message: message, Fatal: fatal})
}
