package protocol

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestFormatTimeISO8601Millis(t *testing.T) {
	tm := time.Date(2026, 7, 2, 12, 34, 56, 789_000_000, time.UTC)
	got := FormatTime(tm)
	want := "2026-07-02T12:34:56.789Z"
	if got != want {
		t.Fatalf("FormatTime = %q, want %q", got, want)
	}
}

func TestFormatTimeConvertsToUTC(t *testing.T) {
	loc := time.FixedZone("IST", 5*3600+1800) // +05:30
	tm := time.Date(2026, 7, 2, 18, 4, 56, 789_000_000, loc)
	got := FormatTime(tm)
	want := "2026-07-02T12:34:56.789Z"
	if got != want {
		t.Fatalf("FormatTime(non-UTC) = %q, want %q", got, want)
	}
}

// decodeLines splits NDJSON output and decodes each line into a generic map.
func decodeLines(t *testing.T, b []byte) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("line not valid JSON: %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func TestWriterEmitsOneJSONPerLineWithDiscriminator(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	if err := w.Ready(); err != nil {
		t.Fatal(err)
	}
	if err := w.Status(StateOnline, "ok", "jid@s", "Me"); err != nil {
		t.Fatal(err)
	}
	if err := w.QR("2@abc", 60); err != nil {
		t.Fatal(err)
	}
	if err := w.Paired("jid@s", "Me"); err != nil {
		t.Fatal(err)
	}
	if err := w.Channel(Channel{SourceExtID: "c@s", Name: "Mom", Kind: "dm"}); err != nil {
		t.Fatal(err)
	}
	if err := w.Actor(Actor{SourceExtID: "a@s", DisplayName: "Mom", Handle: "+1", IsSelf: false}); err != nil {
		t.Fatal(err)
	}
	if err := w.Progress("backfill", 1, 3, 5, false, Range7d); err != nil {
		t.Fatal(err)
	}
	if err := w.BackfillComplete(Range7d, 3, 5); err != nil {
		t.Fatal(err)
	}
	if err := w.Error("code", "boom", false); err != nil {
		t.Fatal(err)
	}

	lines := decodeLines(t, buf.Bytes())
	wantTypes := []string{"ready", "status", "qr", "paired", "channel", "actor", "progress", "backfill_complete", "error"}
	if len(lines) != len(wantTypes) {
		t.Fatalf("got %d lines, want %d", len(lines), len(wantTypes))
	}
	for i, wt := range wantTypes {
		if lines[i]["t"] != wt {
			t.Errorf("line %d: t = %v, want %q", i, lines[i]["t"], wt)
		}
	}

	// Spot-check field names on the status and progress lines match the contract.
	status := lines[1]
	for _, k := range []string{"state", "detail", "jid", "push_name"} {
		if _, ok := status[k]; !ok {
			t.Errorf("status missing key %q", k)
		}
	}
	prog := lines[6]
	for _, k := range []string{"phase", "chats_done", "chats_total", "messages", "done", "range"} {
		if _, ok := prog[k]; !ok {
			t.Errorf("progress missing key %q", k)
		}
	}
}

func TestEventRoundTrip(t *testing.T) {
	orig := Event{
		ExternalID:   "chat@s.whatsapp.net/MSG123",
		ChannelExtID: "chat@s.whatsapp.net",
		ActorExtID:   "sender@s.whatsapp.net",
		TS:           "2026-07-02T12:34:56.789Z",
		Kind:         KindImage,
		Text:         "caption",
		Media: &Media{
			Path: "/media/chat/MSG123.jpg", Mime: "image/jpeg",
			Filename: "IMG.jpg", Size: 12345, SHA256: "deadbeef",
		},
		FromMe: true,
		Raw:    map[string]any{"id": "MSG123", "type": "image"},
	}

	var buf bytes.Buffer
	w := NewWriter(&buf)
	if err := w.Event(orig); err != nil {
		t.Fatal(err)
	}

	// Decode as the wire envelope and assert exact JSON field names.
	var env struct {
		T     string `json:"t"`
		Event Event  `json:"event"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if env.T != "event" {
		t.Errorf("t = %q, want event", env.T)
	}
	got := env.Event
	if got.ExternalID != orig.ExternalID || got.ChannelExtID != orig.ChannelExtID ||
		got.ActorExtID != orig.ActorExtID || got.TS != orig.TS || got.Kind != orig.Kind ||
		got.Text != orig.Text || got.FromMe != orig.FromMe {
		t.Errorf("event scalar mismatch: got %+v", got)
	}
	if got.Media == nil || got.Media.SHA256 != "deadbeef" || got.Media.Size != 12345 {
		t.Errorf("media round-trip failed: %+v", got.Media)
	}

	// Confirm the raw JSON uses snake_case keys exactly (contract §3).
	var raw map[string]any
	_ = json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &raw)
	ev := raw["event"].(map[string]any)
	for _, k := range []string{"external_id", "channel_ext_id", "actor_ext_id", "ts", "kind", "text", "media", "from_me", "raw"} {
		if _, ok := ev[k]; !ok {
			t.Errorf("event JSON missing key %q", k)
		}
	}
}

func TestEventMediaNullWhenAbsent(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	_ = w.Event(Event{ExternalID: "c/1", Kind: KindMessage, Text: "hi", Raw: map[string]any{}})

	var raw map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &raw); err != nil {
		t.Fatal(err)
	}
	ev := raw["event"].(map[string]any)
	if ev["media"] != nil {
		t.Errorf("media should be null when absent, got %v", ev["media"])
	}
}

// TestRichMediaFieldNames pins the wire names of the additive media/event fields
// (docs/rich-media-spec.md §1/§2). The worker joins on these exact keys, so a
// rename here silently breaks ingestion on the other side of the pipe.
func TestRichMediaFieldNames(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	_ = w.Event(Event{
		ExternalID: "chat@s.whatsapp.net/MSG1",
		Kind:       KindVideo,
		Media: &Media{
			Path: "/media/chat/MSG1.mp4", ThumbPath: "/media/chat/MSG1.thumb.jpg",
			Width: 720, Height: 1280, Seconds: 15, Pages: 3,
			Caption: "clip", Voice: true, Animated: true,
		},
		EditOfExternalID:   "chat@s.whatsapp.net/ORIG",
		RevokeOfExternalID: "chat@s.whatsapp.net/GONE",
		IsForwarded:        true,
		MentionedExtIDs:    []string{"15551234567@s.whatsapp.net"},
		Raw:                map[string]any{},
	})

	var raw map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &raw); err != nil {
		t.Fatal(err)
	}
	ev := raw["event"].(map[string]any)
	for _, k := range []string{"edit_of_external_id", "revoke_of_external_id", "is_forwarded", "mentioned_ext_ids"} {
		if _, ok := ev[k]; !ok {
			t.Errorf("event JSON missing key %q", k)
		}
	}
	media := ev["media"].(map[string]any)
	for _, k := range []string{"thumb_path", "width", "height", "seconds", "pages", "caption", "voice", "animated"} {
		if _, ok := media[k]; !ok {
			t.Errorf("media JSON missing key %q", k)
		}
	}
}

// TestRichMediaFieldsOmittedWhenUnset proves the additive fields are omitempty:
// a plain text message must keep the exact shape the worker already parses.
func TestRichMediaFieldsOmittedWhenUnset(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	_ = w.Event(Event{
		ExternalID: "chat@s.whatsapp.net/MSG2",
		Kind:       KindMessage,
		Text:       "hi",
		Media:      &Media{Path: "/media/chat/MSG2.jpg", Mime: "image/jpeg"},
		Raw:        map[string]any{},
	})

	var raw map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &raw); err != nil {
		t.Fatal(err)
	}
	ev := raw["event"].(map[string]any)
	for _, k := range []string{"edit_of_external_id", "revoke_of_external_id", "is_forwarded", "mentioned_ext_ids"} {
		if _, ok := ev[k]; ok {
			t.Errorf("event JSON should omit %q when unset", k)
		}
	}
	media := ev["media"].(map[string]any)
	for _, k := range []string{"thumb_path", "width", "height", "seconds", "pages", "caption", "voice", "animated"} {
		if _, ok := media[k]; ok {
			t.Errorf("media JSON should omit %q when unset", k)
		}
	}
}

// TestHistoryFieldName pins the wire name of the import/live distinction
// (v4-spec §4b). It is omitempty, so a live message keeps the exact shape the
// worker already parses and only an imported row grows the extra key.
//
// It also pins the album keys' ABSENCE: album_id / album_count were the only
// grouping the stream ever carried, the grouping is gone (v7-spec §1), and an
// event that still emitted them would resurrect a container row the UI has no
// renderer for.
func TestHistoryFieldName(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	_ = w.Event(Event{
		ExternalID:   "chat@s.whatsapp.net/HIST",
		Kind:         KindImage,
		IsHistorical: true,
		Raw:          map[string]any{},
	})
	_ = w.Event(Event{
		ExternalID: "chat@s.whatsapp.net/LIVE",
		Kind:       KindMessage,
		Text:       "hi",
		Raw:        map[string]any{},
	})

	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n"))
	if len(lines) != 2 {
		t.Fatalf("wrote %d lines, want 2", len(lines))
	}
	event := func(line []byte) map[string]any {
		var raw map[string]any
		if err := json.Unmarshal(line, &raw); err != nil {
			t.Fatal(err)
		}
		return raw["event"].(map[string]any)
	}

	imported := event(lines[0])
	if got, ok := imported["is_historical"]; !ok || got != true {
		t.Errorf("imported event is_historical = %v, want true", got)
	}

	plain := event(lines[1])
	if _, ok := plain["is_historical"]; ok {
		t.Error("a live event should omit is_historical")
	}
	for _, ev := range []map[string]any{imported, plain} {
		for k := range ev {
			if strings.HasPrefix(k, "album") {
				t.Errorf("event JSON still carries %q; albums are gone from the stream", k)
			}
		}
	}
}

// TestLinkFieldNames pins the wire names of the link preview (v3-spec §3). A
// URL-only link (plain text, no preview) must still carry the `url` key and omit
// the rest, and `link` is null — not absent — when the message has no URL at all.
func TestLinkFieldNames(t *testing.T) {
	tests := []struct {
		name       string
		link       *Link
		wantKeys   []string
		wantOmit   []string
		wantIsNull bool
	}{
		{
			name: "full preview",
			link: &Link{
				URL: "https://example.com/a", Title: "Example", Description: "A page",
				ThumbPath: "/media/chat/MSG1.link.thumb.jpg", PreviewType: "image",
			},
			wantKeys: []string{"url", "title", "description", "thumb_path", "preview_type"},
		},
		{
			name:     "url only",
			link:     &Link{URL: "https://example.com/a"},
			wantKeys: []string{"url"},
			wantOmit: []string{"title", "description", "thumb_path", "preview_type"},
		},
		{name: "no link", wantIsNull: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			w := NewWriter(&buf)
			_ = w.Event(Event{ExternalID: "chat@s.whatsapp.net/MSG1", Kind: KindMessage, Link: tt.link, Raw: map[string]any{}})

			var raw map[string]any
			if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &raw); err != nil {
				t.Fatal(err)
			}
			ev := raw["event"].(map[string]any)
			if _, ok := ev["link"]; !ok {
				t.Fatal("event JSON missing key \"link\"")
			}
			if tt.wantIsNull {
				if ev["link"] != nil {
					t.Fatalf("link should be null when absent, got %v", ev["link"])
				}
				return
			}
			link := ev["link"].(map[string]any)
			for _, k := range tt.wantKeys {
				if _, ok := link[k]; !ok {
					t.Errorf("link JSON missing key %q", k)
				}
			}
			for _, k := range tt.wantOmit {
				if _, ok := link[k]; ok {
					t.Errorf("link JSON should omit %q when unset", k)
				}
			}
		})
	}
}

// TestChannelBusinessFieldName pins `is_business` (v3-spec §5). It is written
// unconditionally: the worker's media gate reads a persisted column, so an absent
// key on a re-emitted channel would leave a stale true in place.
func TestChannelBusinessFieldName(t *testing.T) {
	for _, business := range []bool{true, false} {
		var buf bytes.Buffer
		w := NewWriter(&buf)
		_ = w.Channel(Channel{SourceExtID: "biz@s.whatsapp.net", Name: "Jio", Kind: "dm", IsBusiness: business})

		var raw map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &raw); err != nil {
			t.Fatal(err)
		}
		ch := raw["channel"].(map[string]any)
		if got, ok := ch["is_business"]; !ok || got != business {
			t.Errorf("channel is_business = %v (present %v), want %v", got, ok, business)
		}
	}
}

func TestDecodeCommand(t *testing.T) {
	tests := []struct {
		line      string
		wantCmd   string
		wantRange Range
	}{
		{`{"cmd":"start_pairing"}`, "start_pairing", ""},
		{`{"cmd":"import","range":"7d"}`, "import", Range7d},
		{`{"cmd":"extend","range":"all"}`, "extend", RangeAll},
		{`{"cmd":"shutdown"}`, "shutdown", ""},
	}
	for _, tt := range tests {
		c, err := DecodeCommand([]byte(tt.line))
		if err != nil {
			t.Errorf("DecodeCommand(%q) error: %v", tt.line, err)
			continue
		}
		if c.Cmd != tt.wantCmd || c.Range != tt.wantRange {
			t.Errorf("DecodeCommand(%q) = {%q,%q}, want {%q,%q}", tt.line, c.Cmd, c.Range, tt.wantCmd, tt.wantRange)
		}
	}
}

func TestReadCommandsSkipsGarbageAndBlanks(t *testing.T) {
	input := strings.NewReader(strings.Join([]string{
		`{"cmd":"start_pairing"}`,
		``,
		`not json at all`,
		`{"cmd":"import","range":"30d"}`,
		`   `,
		`{"cmd":"shutdown"}`,
	}, "\n"))

	var got []Command
	if err := ReadCommands(input, func(c Command) { got = append(got, c) }); err != nil {
		t.Fatal(err)
	}
	want := []string{"start_pairing", "import", "shutdown"}
	if len(got) != len(want) {
		t.Fatalf("got %d commands, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Cmd != w {
			t.Errorf("command %d = %q, want %q", i, got[i].Cmd, w)
		}
	}
	if got[1].Range != Range30d {
		t.Errorf("import range = %q, want 30d", got[1].Range)
	}
}
