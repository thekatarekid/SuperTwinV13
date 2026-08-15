package wa

import (
	"os"
	"path/filepath"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// TestFirstURL pins the plain-text URL extractor (v3-spec §3): explicit schemes
// only, and the trailing punctuation a link picks up from the sentence around it
// is not part of the link.
func TestFirstURL(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "bare url", in: "https://example.com/a", want: "https://example.com/a"},
		{name: "url mid sentence", in: "see https://example.com/a for more", want: "https://example.com/a"},
		{name: "trailing period", in: "read https://example.com/a.", want: "https://example.com/a"},
		{name: "trailing comma", in: "https://example.com/a, then", want: "https://example.com/a"},
		{name: "wrapped in parens", in: "(see https://example.com/a)", want: "https://example.com/a"},
		{name: "balanced parens are part of the url", in: "https://en.wikipedia.org/wiki/Foo_(bar)", want: "https://en.wikipedia.org/wiki/Foo_(bar)"},
		{name: "http is matched too", in: "http://example.com", want: "http://example.com"},
		{name: "first of several wins", in: "https://a.example https://b.example", want: "https://a.example"},
		{name: "a scheme-less host is not a url", in: "go to example.com", want: ""},
		{name: "other schemes are not urls", in: "ftp://example.com/x", want: ""},
		{name: "no url", in: "no links here", want: ""},
		{name: "empty", in: "", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := firstURL(tt.in); got != tt.want {
				t.Fatalf("firstURL(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestPreviewTypeName proves NONE — the enum's zero value — renders empty so the
// field is omitted, and a real preview type renders as a lowercase wire value.
func TestPreviewTypeName(t *testing.T) {
	tests := []struct {
		in   waE2E.ExtendedTextMessage_PreviewType
		want string
	}{
		{in: waE2E.ExtendedTextMessage_NONE, want: ""},
		{in: waE2E.ExtendedTextMessage_VIDEO, want: "video"},
		{in: waE2E.ExtendedTextMessage_IMAGE, want: "image"},
		{in: waE2E.ExtendedTextMessage_PAYMENT_LINKS, want: "payment_links"},
	}
	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			if got := previewTypeName(tt.in); got != tt.want {
				t.Fatalf("previewTypeName(%v) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestMessageLink proves every link shape the daemon can see (v3-spec §3):
// an ExtendedTextMessage preview (MatchedText IS the canonical URL on this
// whatsmeow version), a plain Conversation whose URL is only in the text, a media
// caption, and the shapes that carry no link at all.
func TestMessageLink(t *testing.T) {
	tests := []struct {
		name string
		msg  *waE2E.Message
		want *protocol.Link
	}{
		{
			name: "extended text preview",
			msg: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
				Text:        strp("look at this https://example.com/a"),
				MatchedText: strp("https://example.com/a"),
				Title:       strp("Example Domain"),
				Description: strp("A page about examples"),
				PreviewType: waE2E.ExtendedTextMessage_IMAGE.Enum(),
			}},
			want: &protocol.Link{
				URL:         "https://example.com/a",
				Title:       "Example Domain",
				Description: "A page about examples",
				PreviewType: "image",
			},
		},
		{
			// WhatsApp only fills MatchedText when it managed to fetch a preview.
			name: "extended text without a preview falls back to the body",
			msg: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
				Text: strp("mirror at https://example.com/b please"),
			}},
			want: &protocol.Link{URL: "https://example.com/b"},
		},
		{
			name: "plain conversation",
			msg:  &waE2E.Message{Conversation: strp("agenda: https://example.com/c")},
			want: &protocol.Link{URL: "https://example.com/c"},
		},
		{
			name: "wrapped plain conversation",
			msg:  wrapEphemeral(&waE2E.Message{Conversation: strp("agenda: https://example.com/c")}),
			want: &protocol.Link{URL: "https://example.com/c"},
		},
		{
			name: "image caption",
			msg: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
				Mimetype: strp("image/jpeg"),
				Caption:  strp("from https://example.com/d"),
			}},
			want: &protocol.Link{URL: "https://example.com/d"},
		},
		{name: "plain text with no url", msg: &waE2E.Message{Conversation: strp("hey")}},
		{name: "sticker carries no text at all", msg: &waE2E.Message{StickerMessage: &waE2E.StickerMessage{Mimetype: strp("image/webp")}}},
		{name: "nil message", msg: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := newTestEngine()
			got := e.messageLink("chat@s.whatsapp.net", "MSG1", tt.msg)
			if tt.want == nil {
				if got != nil {
					t.Fatalf("messageLink() = %+v, want nil", got)
				}
				return
			}
			if got == nil {
				t.Fatal("messageLink() = nil, want a link")
			}
			if *got != *tt.want {
				t.Fatalf("messageLink() = %+v, want %+v", *got, *tt.want)
			}
		})
	}
}

// TestLinkPreviewThumbnailWritten proves a preview's JPEGThumbnail lands on disk
// beside the chat's media and is named on the event's link. A preview has no
// downloadable media behind it, so these bytes are the only picture there is.
func TestLinkPreviewThumbnailWritten(t *testing.T) {
	e, _ := newTestEngine()
	e.mediaDir = t.TempDir()
	peer := mustJID(t, "15551234567@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "LINK1",
		MessageSource: types.MessageSource{Chat: peer, Sender: peer},
	}
	msg := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text:          strp("https://example.com/a"),
		MatchedText:   strp("https://example.com/a"),
		JPEGThumbnail: []byte("previewbytes"),
	}}

	ev, _, _, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("a link message must map")
	}
	if ev.Link == nil {
		t.Fatal("event carried no link")
	}
	want := filepath.Join(e.mediaDir, peer.String(), "LINK1.link.thumb.jpg")
	if ev.Link.ThumbPath != want {
		t.Fatalf("link thumb_path = %q, want %q", ev.Link.ThumbPath, want)
	}
	b, err := os.ReadFile(ev.Link.ThumbPath)
	if err != nil {
		t.Fatalf("read link thumbnail: %v", err)
	}
	if string(b) != "previewbytes" {
		t.Fatalf("link thumbnail bytes = %q, want the preview bytes", b)
	}
	// The link is decoration on a text message; it must not be re-kinded as media.
	if ev.Kind != protocol.KindMessage || ev.Media != nil {
		t.Fatalf("event = (%q, media %v), want a plain message with no media", ev.Kind, ev.Media)
	}
}

// TestPlainMessageHasNoLink guards the other side: an ordinary message must keep
// the exact shape the worker already parses, with link null.
func TestPlainMessageHasNoLink(t *testing.T) {
	e, _ := newTestEngine()
	peer := mustJID(t, "15551234567@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "PLAIN1",
		MessageSource: types.MessageSource{Chat: peer, Sender: peer},
	}
	ev, _, _, ok := e.mapMessage(info, &waE2E.Message{Conversation: strp("hi")})
	if !ok {
		t.Fatal("a plain message must map")
	}
	if ev.Link != nil {
		t.Fatalf("link = %+v, want nil for a message with no URL", ev.Link)
	}
}
