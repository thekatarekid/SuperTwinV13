package wa

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

func i64p(v int64) *int64     { return &v }
func f64p(v float64) *float64 { return &v }

// TestClassifyNewMessageKinds proves the message types that previously fell
// through to the contentless system path — and were therefore DROPPED — now
// classify with real content (rich-media-spec §3).
func TestClassifyNewMessageKinds(t *testing.T) {
	tests := []struct {
		name     string
		msg      *waE2E.Message
		wantKind protocol.Kind
		wantText string
		wantDL   bool
	}{
		{
			name: "ptv round video note downloads as video",
			msg: &waE2E.Message{PtvMessage: &waE2E.VideoMessage{
				Mimetype: strp("video/mp4"),
				Seconds:  u32p(7),
			}},
			wantKind: protocol.KindVideo,
			wantDL:   true,
		},
		{
			name: "live location with caption",
			msg: &waE2E.Message{LiveLocationMessage: &waE2E.LiveLocationMessage{
				DegreesLatitude:  f64p(12.5),
				DegreesLongitude: f64p(77.25),
				Caption:          strp("on my way"),
			}},
			wantKind: protocol.KindLiveLocation,
			wantText: "on my way (12.500000,77.250000)",
		},
		{
			name: "live location without caption is bare coordinates",
			msg: &waE2E.Message{LiveLocationMessage: &waE2E.LiveLocationMessage{
				DegreesLatitude:  f64p(12.5),
				DegreesLongitude: f64p(77.25),
			}},
			wantKind: protocol.KindLiveLocation,
			wantText: "12.500000,77.250000",
		},
		{
			name: "contacts array lists the shared names",
			msg: &waE2E.Message{ContactsArrayMessage: &waE2E.ContactsArrayMessage{
				Contacts: []*waE2E.ContactMessage{
					{DisplayName: strp("Ann")},
					{DisplayName: strp("Bob")},
				},
			}},
			wantKind: protocol.KindContact,
			wantText: "Ann, Bob",
		},
		{
			name: "contacts array falls back to its own label",
			msg: &waE2E.Message{ContactsArrayMessage: &waE2E.ContactsArrayMessage{
				DisplayName: strp("3 contacts"),
			}},
			wantKind: protocol.KindContact,
			wantText: "3 contacts",
		},
		{
			// V4 nests its poll inside a FutureProofMessage instead of carrying it.
			name: "poll creation v4 unwraps to the question",
			msg: &waE2E.Message{PollCreationMessageV4: &waE2E.FutureProofMessage{
				Message: &waE2E.Message{PollCreationMessage: &waE2E.PollCreationMessage{
					Name: strp("Lunch?"),
				}},
			}},
			wantKind: protocol.KindPoll,
			wantText: "📊 Lunch?",
		},
		{
			name: "poll creation v5",
			msg: &waE2E.Message{PollCreationMessageV5: &waE2E.PollCreationMessage{
				Name: strp("Standup time?"),
			}},
			wantKind: protocol.KindPoll,
			wantText: "📊 Standup time?",
		},
		{
			name: "poll creation v6",
			msg: &waE2E.Message{PollCreationMessageV6: &waE2E.PollCreationMessage{
				Name: strp("Offsite venue?"),
			}},
			wantKind: protocol.KindPoll,
			wantText: "📊 Offsite venue?",
		},
		{
			// The chosen option is encrypted, so only the fact of the vote survives.
			name: "poll vote",
			msg: &waE2E.Message{PollUpdateMessage: &waE2E.PollUpdateMessage{
				PollCreationMessageKey: &waCommon.MessageKey{ID: strp("POLL1")},
			}},
			wantKind: protocol.KindPollVote,
		},
		{
			name: "encrypted reaction",
			msg: &waE2E.Message{EncReactionMessage: &waE2E.EncReactionMessage{
				TargetMessageKey: &waCommon.MessageKey{ID: strp("TGT1")},
			}},
			wantKind: protocol.KindReaction,
		},
		{
			name: "missed voice call",
			msg: &waE2E.Message{CallLogMesssage: &waE2E.CallLogMessage{
				CallOutcome: waE2E.CallLogMessage_MISSED.Enum(),
			}},
			wantKind: protocol.KindCall,
			wantText: "📞 Voice call (missed)",
		},
		{
			name: "connected video call carries its duration",
			msg: &waE2E.Message{CallLogMesssage: &waE2E.CallLogMessage{
				IsVideo:      boolp(true),
				CallOutcome:  waE2E.CallLogMessage_CONNECTED.Enum(),
				DurationSecs: i64p(42),
			}},
			wantKind: protocol.KindCall,
			wantText: "📞 Video call (connected, 42s)",
		},
		{
			name: "scheduled call",
			msg: &waE2E.Message{ScheduledCallCreationMessage: &waE2E.ScheduledCallCreationMessage{
				Title: strp("Weekly sync"),
			}},
			wantKind: protocol.KindCall,
			wantText: "📞 Scheduled call: Weekly sync",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kind, text, dl := classify(tt.msg)
			if kind != tt.wantKind || text != tt.wantText {
				t.Fatalf("classify() = (%q, %q), want (%q, %q)", kind, text, tt.wantKind, tt.wantText)
			}
			if (dl != nil) != tt.wantDL {
				t.Fatalf("classify() downloadable = %v, want %v", dl != nil, tt.wantDL)
			}
		})
	}
}

// TestClassifyMediaMetadata proves every optional Media field in
// rich-media-spec §1 is read off the proto, and that only the types whose own
// bytes are unreadable (video, PTV, document) keep a thumbnail.
func TestClassifyMediaMetadata(t *testing.T) {
	tests := []struct {
		name      string
		msg       *waE2E.Message
		want      protocol.Media
		wantThumb bool
	}{
		{
			name: "image dimensions and caption",
			msg: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
				Mimetype:      strp("image/jpeg"),
				Width:         u32p(1600),
				Height:        u32p(900),
				Caption:       strp("the view"),
				JPEGThumbnail: []byte("thumb"),
			}},
			want: protocol.Media{Width: 1600, Height: 900, Caption: "the view"},
		},
		{
			name: "video duration and gif playback",
			msg: &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
				Mimetype:      strp("video/mp4"),
				Width:         u32p(720),
				Height:        u32p(1280),
				Seconds:       u32p(15),
				Caption:       strp("clip"),
				GifPlayback:   boolp(true),
				JPEGThumbnail: []byte("thumb"),
			}},
			want:      protocol.Media{Width: 720, Height: 1280, Seconds: 15, Caption: "clip", Animated: true},
			wantThumb: true,
		},
		{
			name: "voice note",
			msg: &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
				Mimetype: strp("audio/ogg"),
				Seconds:  u32p(9),
				PTT:      boolp(true),
			}},
			want: protocol.Media{Seconds: 9, Voice: true},
		},
		{
			name: "document page count and caption",
			msg: &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{
				Mimetype:      strp("application/pdf"),
				FileName:      strp("invoice.pdf"),
				PageCount:     u32p(3),
				Caption:       strp("this month"),
				JPEGThumbnail: []byte("thumb"),
			}},
			want:      protocol.Media{Pages: 3, Caption: "this month"},
			wantThumb: true,
		},
		{
			name: "animated sticker",
			msg: &waE2E.Message{StickerMessage: &waE2E.StickerMessage{
				Mimetype:   strp("image/webp"),
				Width:      u32p(512),
				Height:     u32p(512),
				IsAnimated: boolp(true),
			}},
			want: protocol.Media{Width: 512, Height: 512, Animated: true},
		},
		{
			// A round video note is a VideoMessage, and is never a voice note.
			name: "ptv keeps its thumbnail and is not a voice note",
			msg: &waE2E.Message{PtvMessage: &waE2E.VideoMessage{
				Mimetype:      strp("video/mp4"),
				Seconds:       u32p(6),
				JPEGThumbnail: []byte("thumb"),
			}},
			want:      protocol.Media{Seconds: 6},
			wantThumb: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, dl := classify(tt.msg)
			if dl == nil {
				t.Fatal("classify() returned no downloadable")
			}
			if dl.meta != tt.want {
				t.Errorf("media meta = %+v, want %+v", dl.meta, tt.want)
			}
			if got := len(dl.thumb) > 0; got != tt.wantThumb {
				t.Errorf("thumbnail retained = %v, want %v", got, tt.wantThumb)
			}
		})
	}
}

// TestWriteThumbnail proves the JPEGThumbnail lands next to the media file, and
// that an absent or unwritable thumbnail degrades to "" instead of failing the
// download (rich-media-spec §1).
func TestWriteThumbnail(t *testing.T) {
	e, _ := newTestEngine()
	dir := t.TempDir()

	tests := []struct {
		name    string
		dir     string
		msgID   string
		thumb   []byte
		wantRel string
	}{
		{name: "writes jpeg next to the media", dir: dir, msgID: "MSG1", thumb: []byte("jpegbytes"), wantRel: "MSG1.thumb.jpg"},
		{name: "empty thumbnail is skipped", dir: dir, msgID: "MSG2"},
		{name: "unwritable directory degrades to empty", dir: filepath.Join(dir, "missing"), msgID: "MSG3", thumb: []byte("jpegbytes")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := e.writeThumbnail(tt.dir, tt.msgID, tt.thumb)
			if tt.wantRel == "" {
				if got != "" {
					t.Fatalf("writeThumbnail() = %q, want empty", got)
				}
				return
			}
			want := filepath.Join(tt.dir, tt.wantRel)
			if got != want {
				t.Fatalf("writeThumbnail() = %q, want %q", got, want)
			}
			b, err := os.ReadFile(got)
			if err != nil {
				t.Fatalf("read thumbnail: %v", err)
			}
			if string(b) != string(tt.thumb) {
				t.Fatalf("thumbnail bytes = %q, want %q", b, tt.thumb)
			}
		})
	}
}

// TestMediaExtension pins the extension media is written with. It is what tells
// the media reader whether a document is readable at all (rich-media-spec §8),
// and WhatsApp attaches parameters to its mimes ("audio/ogg; codecs=opus").
func TestMediaExtension(t *testing.T) {
	mimes := []struct {
		mime string
		def  string
		want string
	}{
		{mime: "image/jpeg", def: "jpg", want: "jpg"},
		{mime: "audio/ogg; codecs=opus", def: "ogg", want: "ogg"},
		{mime: "AUDIO/OGG", def: "ogg", want: "ogg"},
		{mime: "application/pdf", def: "bin", want: "pdf"},
		{mime: "text/plain", def: "bin", want: "txt"},
		{mime: "text/markdown", def: "bin", want: "md"},
		{mime: "text/csv", def: "bin", want: "csv"},
		{mime: "application/json", def: "bin", want: "json"},
		{mime: "application/vnd.oasis.opendocument.text", def: "bin", want: "bin"},
		{mime: "", def: "bin", want: "bin"},
	}
	for _, tt := range mimes {
		t.Run("mime "+tt.mime, func(t *testing.T) {
			if got := extFor(tt.mime, tt.def); got != tt.want {
				t.Fatalf("extFor(%q, %q) = %q, want %q", tt.mime, tt.def, got, tt.want)
			}
		})
	}

	// A document's own filename wins over its mime; a name with no usable
	// extension falls back to the mime-derived one.
	names := []struct {
		name string
		def  string
		want string
	}{
		{name: "invoice.pdf", def: "bin", want: "pdf"},
		{name: "notes.txt", def: "bin", want: "txt"},
		{name: "backup.tar.gz", def: "bin", want: "gz"},
		{name: "statement", def: "pdf", want: "pdf"},
		{name: "statement.", def: "pdf", want: "pdf"},
		{name: "", def: "pdf", want: "pdf"},
	}
	for _, tt := range names {
		t.Run("filename "+tt.name, func(t *testing.T) {
			if got := extFromName(tt.name, tt.def); got != tt.want {
				t.Fatalf("extFromName(%q, %q) = %q, want %q", tt.name, tt.def, got, tt.want)
			}
		})
	}
}

// TestSafePathSegment proves a media path segment can never climb out of the
// media directory. The chat JID and the message id are both remote-controlled —
// whatsmeow copies MessageInfo.ID straight off the stanza — so a peer that sends
// media with an id of "../../../../x" would otherwise pick where the file lands.
func TestSafePathSegment(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "a real chat jid is untouched", in: "15551234567@s.whatsapp.net", want: "15551234567@s.whatsapp.net"},
		{name: "a real group jid is untouched", in: "120363000000000001@g.us", want: "120363000000000001@g.us"},
		{name: "a real stanza id is untouched", in: "3EB0C767D0E1A3B2F4-5_", want: "3EB0C767D0E1A3B2F4-5_"},
		{name: "separators are neutralized", in: "../../../../etc/passwd", want: ".._.._.._.._etc_passwd"},
		{name: "a dot-only segment is replaced", in: "..", want: "_"},
		{name: "an empty segment is replaced", in: "", want: "_"},
		{name: "a nul byte is neutralized", in: "a\x00b", want: "a_b"},
	}
	root := t.TempDir()
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := safePathSegment(tt.in)
			if got != tt.want {
				t.Fatalf("safePathSegment(%q) = %q, want %q", tt.in, got, tt.want)
			}
			// The invariant the media path relies on: one segment, never a
			// traversal, so filepath.Join can only ever descend.
			if joined := filepath.Join(root, got); !strings.HasPrefix(joined, root+string(filepath.Separator)) {
				t.Fatalf("filepath.Join(root, %q) = %q escaped %q", got, joined, root)
			}
		})
	}
}

// TestBusinessHeaderMediaAttached proves a business card's header picture is
// downloaded and the event takes the media's kind while KEEPING the rendered
// body text — the "WhatsApp's announcement card came through as text only" bug
// (rich-media-spec §1).
func TestBusinessHeaderMediaAttached(t *testing.T) {
	tests := []struct {
		name     string
		msg      *waE2E.Message
		wantKind protocol.Kind
		wantText string
		wantMime string
	}{
		{
			name: "hydrated template image header",
			msg: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
					HydratedContentText: strp("Introducing passkeys."),
					Title: &waE2E.TemplateMessage_HydratedFourRowTemplate_ImageMessage{
						ImageMessage: &waE2E.ImageMessage{Mimetype: strp("image/jpeg")},
					},
				},
			}},
			wantKind: protocol.KindImage,
			wantText: "Introducing passkeys.",
			wantMime: "image/jpeg",
		},
		{
			name: "interactive header video",
			msg: &waE2E.Message{InteractiveMessage: &waE2E.InteractiveMessage{
				Body: &waE2E.InteractiveMessage_Body{Text: strp("Watch the demo")},
				Header: &waE2E.InteractiveMessage_Header{
					Media: &waE2E.InteractiveMessage_Header_VideoMessage{
						VideoMessage: &waE2E.VideoMessage{Mimetype: strp("video/mp4")},
					},
				},
			}},
			wantKind: protocol.KindVideo,
			wantText: "Watch the demo",
			wantMime: "video/mp4",
		},
		{
			name: "four-row template document header",
			msg: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				Format: &waE2E.TemplateMessage_FourRowTemplate_{
					FourRowTemplate: &waE2E.TemplateMessage_FourRowTemplate{
						Content: &waE2E.HighlyStructuredMessage{
							LocalizableParams: []*waE2E.HighlyStructuredMessage_HSMLocalizableParameter{
								{Default: strp("Your statement is ready")},
							},
						},
						Title: &waE2E.TemplateMessage_FourRowTemplate_DocumentMessage{
							DocumentMessage: &waE2E.DocumentMessage{
								Mimetype: strp("application/pdf"),
								FileName: strp("statement.pdf"),
							},
						},
					},
				},
			}},
			wantKind: protocol.KindDocument,
			wantText: "Your statement is ready",
			wantMime: "application/pdf",
		},
		{
			name: "product image",
			msg: &waE2E.Message{ProductMessage: &waE2E.ProductMessage{
				Body: strp("Buy the widget"),
				Product: &waE2E.ProductMessage_ProductSnapshot{
					ProductImage: &waE2E.ImageMessage{Mimetype: strp("image/png")},
				},
			}},
			wantKind: protocol.KindImage,
			wantText: "Buy the widget",
			wantMime: "image/png",
		},
		{
			// A header-less business card still ingests as plain text.
			name: "template without header media stays a message",
			msg: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
					HydratedContentText: strp("Your order shipped."),
				},
			}},
			wantKind: protocol.KindMessage,
			wantText: "Your order shipped.",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kind, text, dl := classify(tt.msg)
			if kind != tt.wantKind || text != tt.wantText {
				t.Fatalf("classify() = (%q, %q), want (%q, %q)", kind, text, tt.wantKind, tt.wantText)
			}
			if tt.wantMime == "" {
				if dl != nil {
					t.Fatalf("classify() attached media %+v, want none", dl)
				}
				return
			}
			if dl == nil {
				t.Fatal("header media was not attached")
			}
			if dl.mime != tt.wantMime {
				t.Fatalf("header media mime = %q, want %q", dl.mime, tt.wantMime)
			}
		})
	}
}

// TestBusinessHeaderMediaGaps covers the business shapes whose picture the daemon
// never descended into (v3-spec §5). Each is the ONLY image the recipient saw, so
// a miss here is a business card that ingests as text.
func TestBusinessHeaderMediaGaps(t *testing.T) {
	tests := []struct {
		name string
		msg  *waE2E.Message
		// wantMime is set for a downloadable payload; wantThumb for a payload whose
		// only bytes are a raw JPEGThumbnail with nothing to download behind it.
		wantMime  string
		wantThumb string
	}{
		{
			// A carousel keeps its pictures AND its text on the cards, never on the
			// message, so neither is reachable without descending.
			name: "carousel card header image",
			msg: &waE2E.Message{InteractiveMessage: &waE2E.InteractiveMessage{
				InteractiveMessage: &waE2E.InteractiveMessage_CarouselMessage_{
					CarouselMessage: &waE2E.InteractiveMessage_CarouselMessage{
						Cards: []*waE2E.InteractiveMessage{
							{Body: &waE2E.InteractiveMessage_Body{Text: strp("This week's offers")}},
							{Header: &waE2E.InteractiveMessage_Header{
								Media: &waE2E.InteractiveMessage_Header_ImageMessage{
									ImageMessage: &waE2E.ImageMessage{Mimetype: strp("image/jpeg")},
								},
							}},
						},
					},
				},
			}},
			wantMime: "image/jpeg",
		},
		{
			name: "interactive header product variant",
			msg: &waE2E.Message{InteractiveMessage: &waE2E.InteractiveMessage{
				Body: &waE2E.InteractiveMessage_Body{Text: strp("Featured item")},
				Header: &waE2E.InteractiveMessage_Header{
					Media: &waE2E.InteractiveMessage_Header_ProductMessage{
						ProductMessage: &waE2E.ProductMessage{Product: &waE2E.ProductMessage_ProductSnapshot{
							ProductImage: &waE2E.ImageMessage{Mimetype: strp("image/png")},
						}},
					},
				},
			}},
			wantMime: "image/png",
		},
		{
			name: "interactive header raw thumbnail",
			msg: &waE2E.Message{InteractiveMessage: &waE2E.InteractiveMessage{
				Body: &waE2E.InteractiveMessage_Body{Text: strp("Tap to view")},
				Header: &waE2E.InteractiveMessage_Header{
					Title: strp("Autumn sale"),
					Media: &waE2E.InteractiveMessage_Header_JPEGThumbnail{JPEGThumbnail: []byte("headerbytes")},
				},
			}},
			wantThumb: "headerbytes",
		},
		{
			// structuredText already recurses into HydratedHsm for the text; the
			// picture on the same card was left behind.
			name: "highly structured message hydrated hsm header",
			msg: &waE2E.Message{HighlyStructuredMessage: &waE2E.HighlyStructuredMessage{
				HydratedHsm: &waE2E.TemplateMessage{
					HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
						HydratedContentText: strp("Your statement is ready"),
						Title: &waE2E.TemplateMessage_HydratedFourRowTemplate_ImageMessage{
							ImageMessage: &waE2E.ImageMessage{Mimetype: strp("image/jpeg")},
						},
					},
				},
			}},
			wantMime: "image/jpeg",
		},
		{
			name: "four-row template content nests a hydrated card with media",
			msg: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				Format: &waE2E.TemplateMessage_FourRowTemplate_{
					FourRowTemplate: &waE2E.TemplateMessage_FourRowTemplate{
						Content: &waE2E.HighlyStructuredMessage{
							LocalizableParams: []*waE2E.HighlyStructuredMessage_HSMLocalizableParameter{
								{Default: strp("Your order shipped")},
							},
							HydratedHsm: &waE2E.TemplateMessage{
								HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
									Title: &waE2E.TemplateMessage_HydratedFourRowTemplate_VideoMessage{
										VideoMessage: &waE2E.VideoMessage{Mimetype: strp("video/mp4")},
									},
								},
							},
						},
					},
				},
			}},
			wantMime: "video/mp4",
		},
		{
			name: "product falls back to the catalog cover",
			msg: &waE2E.Message{ProductMessage: &waE2E.ProductMessage{
				Body:    strp("Browse the catalog"),
				Catalog: &waE2E.ProductMessage_CatalogSnapshot{CatalogImage: &waE2E.ImageMessage{Mimetype: strp("image/webp")}},
			}},
			wantMime: "image/webp",
		},
		{
			name: "order card thumbnail",
			msg: &waE2E.Message{OrderMessage: &waE2E.OrderMessage{
				OrderTitle: strp("Order #4821"),
				Thumbnail:  []byte("orderbytes"),
			}},
			wantThumb: "orderbytes",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, text, dl := classify(tt.msg)
			if text == "" || text == businessPlaceholder {
				t.Fatalf("a business card must render real text, got %q", text)
			}
			if dl == nil {
				t.Fatal("business header media was not attached")
			}
			if tt.wantThumb != "" {
				if dl.msg != nil {
					t.Errorf("a raw-thumbnail payload must carry no downloadable message")
				}
				if string(dl.thumb) != tt.wantThumb {
					t.Errorf("thumbnail bytes = %q, want %q", dl.thumb, tt.wantThumb)
				}
				return
			}
			if dl.mime != tt.wantMime {
				t.Errorf("header media mime = %q, want %q", dl.mime, tt.wantMime)
			}
		})
	}
}

// TestExternalAdReplyMedia proves the click-to-WhatsApp ad card — the most common
// business-media shape and entirely unread before — is stored and takes the
// media's kind, so the worker's kind-selected media reader can reach it, while the
// message keeps its own text (v3-spec §5).
func TestExternalAdReplyMedia(t *testing.T) {
	e, _ := newTestEngine()
	e.mediaDir = t.TempDir()
	biz := mustJID(t, "919538251513@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "AD1",
		MessageSource: types.MessageSource{Chat: biz, Sender: biz},
	}
	msg := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: strp("Hi! How can we help?"),
		ContextInfo: &waE2E.ContextInfo{ExternalAdReply: &waE2E.ContextInfo_ExternalAdReplyInfo{
			Title:     strp("Autumn sale"),
			Body:      strp("30% off everything"),
			Thumbnail: []byte("adbytes"),
		}},
	}}

	ev, _, _, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("an ad-reply message must map")
	}
	if ev.Kind != protocol.KindImage || ev.Text != "Hi! How can we help?" {
		t.Fatalf("event = (%q, %q), want an image carrying the message's own text", ev.Kind, ev.Text)
	}
	if ev.Media == nil {
		t.Fatal("the ad card's thumbnail was not stored")
	}
	if ev.Media.Caption != "Autumn sale\n30% off everything" {
		t.Errorf("media caption = %q, want the ad's title and body", ev.Media.Caption)
	}
	b, err := os.ReadFile(ev.Media.Path)
	if err != nil {
		t.Fatalf("read ad thumbnail: %v", err)
	}
	if string(b) != "adbytes" {
		t.Fatalf("ad thumbnail bytes = %q, want the ad bytes", b)
	}

	// An ad card with no thumbnail bytes has no picture to store, so the message
	// must stay exactly what it was.
	info.ID = "AD2"
	msg.GetExtendedTextMessage().GetContextInfo().GetExternalAdReply().Thumbnail = nil
	bare, _, _, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("an ad-reply message must map")
	}
	if bare.Kind != protocol.KindMessage || bare.Media != nil {
		t.Fatalf("event = (%q, media %v), want a plain message with no media", bare.Kind, bare.Media)
	}
}

// TestThumbnailOnlyMedia proves a payload with no downloadable media still lands
// on disk (v3-spec §5). Path POINTS AT THE THUMBNAIL, because the worker's
// claimPendingMedia requires media_path IS NOT NULL — Path == ThumbPath is the
// signal that there was never a full file.
func TestThumbnailOnlyMedia(t *testing.T) {
	e, _ := newTestEngine()
	e.mediaDir = t.TempDir()

	md, err := e.downloadMedia("chat@s.whatsapp.net", "ORD1", thumbnailDownloadable([]byte("orderbytes"), "Order #4821"))
	if err != nil {
		t.Fatalf("downloadMedia() = %v, want the thumbnail stored", err)
	}
	want := filepath.Join(e.mediaDir, "chat@s.whatsapp.net", "ORD1.thumb.jpg")
	if md.Path != want || md.ThumbPath != want {
		t.Fatalf("media path/thumb_path = %q/%q, want both %q", md.Path, md.ThumbPath, want)
	}
	if md.Mime != "image/jpeg" || md.Filename != "ORD1.thumb.jpg" || md.Size != int64(len("orderbytes")) {
		t.Errorf("media descriptor = %+v, want it to describe the thumbnail", md)
	}
	if md.SHA256 == "" {
		t.Error("media sha256 is empty")
	}
	if md.Caption != "Order #4821" {
		t.Errorf("media caption = %q, want the card's own label", md.Caption)
	}
	b, err := os.ReadFile(md.Path)
	if err != nil || string(b) != "orderbytes" {
		t.Fatalf("thumbnail file = %q (%v), want the raw bytes", b, err)
	}

	// Nothing to download AND nothing to write is an error, not an empty row.
	if _, err := e.downloadMedia("chat@s.whatsapp.net", "ORD2", &downloadable{}); err == nil {
		t.Error("a payload with neither media nor thumbnail must fail, not produce an empty descriptor")
	}
}

// TestThumbnailFallbackDescribesTheStoredBytes is the media_seconds=14-on-a-JPEG
// regression (v4-spec §3). When a download fails, the descriptor stops describing
// the file that never arrived: a duration, dimensions, a page count and the
// gif-playback flag all belonged to the original, and only the caption — which
// belongs to the MESSAGE — still holds for the still that was stored instead.
func TestThumbnailFallbackDescribesTheStoredBytes(t *testing.T) {
	tests := []struct {
		name string
		id   string
		dl   *downloadable
	}{
		{
			name: "video keeps its caption and loses its duration",
			id:   "VID1",
			dl: videoDownloadable(&waE2E.VideoMessage{
				Mimetype:      strp("video/mp4"),
				Seconds:       u32p(14),
				Width:         u32p(1280),
				Height:        u32p(720),
				GifPlayback:   boolp(true),
				Caption:       strp("the clip"),
				JPEGThumbnail: []byte("stillbytes"),
			}),
		},
		{
			name: "document loses its page count",
			id:   "DOC1",
			dl: documentDownloadable(&waE2E.DocumentMessage{
				Mimetype:      strp("application/pdf"),
				FileName:      strp("menu.pdf"),
				PageCount:     u32p(12),
				Caption:       strp("the clip"),
				JPEGThumbnail: []byte("stillbytes"),
			}),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := newTestEngine()
			e.mediaDir = t.TempDir()

			// No client, so the download fails and the thumbnail is all that is left.
			md, err := e.downloadMedia("chat@s.whatsapp.net", tt.id, tt.dl)
			if err != nil {
				t.Fatalf("downloadMedia() = %v, want the thumbnail kept", err)
			}
			if md.Path != md.ThumbPath || md.Mime != "image/jpeg" {
				t.Fatalf("descriptor = %+v, want the thumbnail-only shape", md)
			}
			if md.Size != int64(len("stillbytes")) {
				t.Errorf("media size = %d, want the thumbnail's %d", md.Size, len("stillbytes"))
			}
			if md.Caption != "the clip" {
				t.Errorf("media caption = %q, want the message's own caption", md.Caption)
			}
			if md.Seconds != 0 {
				t.Errorf("media seconds = %d on a still image; the duration belonged to the file that failed to download", md.Seconds)
			}
			if md.Width != 0 || md.Height != 0 {
				t.Errorf("media dimensions = %dx%d, want none — those were the original's, not the thumbnail's", md.Width, md.Height)
			}
			if md.Pages != 0 {
				t.Errorf("media pages = %d on a JPEG", md.Pages)
			}
			if md.Animated || md.Voice {
				t.Errorf("media animated=%v voice=%v on a still image", md.Animated, md.Voice)
			}
		})
	}
}

// TestThumbnailFallbackKeepsItsKind proves a video whose download failed is still
// reported as a VIDEO. The stored bytes are a JPEG and media.mime says so — which
// is what the UI renders on — but kind describes what was SENT, and the worker
// gates media reading by kind: relabelling this row image would read a video's
// thumbnail on an account that has video reading switched off (v4-spec §3).
func TestThumbnailFallbackKeepsItsKind(t *testing.T) {
	e, _ := newTestEngine()
	e.mediaDir = t.TempDir()
	peer := mustJID(t, "919538251513@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "VID2",
		MessageSource: types.MessageSource{Chat: peer, Sender: peer},
	}
	msg := &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
		Mimetype:      strp("video/mp4"),
		Seconds:       u32p(14),
		JPEGThumbnail: []byte("stillbytes"),
	}}

	ev, _, _, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("a video must map")
	}
	if ev.Kind != protocol.KindVideo {
		t.Errorf("kind = %q, want video — the user sent a video", ev.Kind)
	}
	if ev.Media == nil || ev.Media.Mime != "image/jpeg" {
		t.Fatalf("media = %+v, want the stored JPEG's own mime", ev.Media)
	}
	if ev.Media.Seconds != 0 {
		t.Errorf("media seconds = %d, want none on the stored still", ev.Media.Seconds)
	}
}

// TestEditAndRevokeTargets proves an edit and a revoke carry the external_id of
// the message they replace/delete, and that a text-less tombstone survives the
// contentless-system drop rule (rich-media-spec §2/§5).
func TestEditAndRevokeTargets(t *testing.T) {
	chat := "15551234567@s.whatsapp.net"
	key := func(id string) *waCommon.MessageKey {
		return &waCommon.MessageKey{ID: strp(id), RemoteJID: strp(chat), FromMe: boolp(true)}
	}

	tests := []struct {
		name       string
		msg        *waE2E.Message
		edit       types.EditAttribute
		wantKind   protocol.Kind
		wantText   string
		wantEdit   string
		wantRevoke string
	}{
		{
			// The shape whatsmeow's BuildEdit produces: the target key sits on a
			// ProtocolMessage that unwrapMessage peels straight past.
			name: "message edit names its target and keeps the new body",
			msg: &waE2E.Message{EditedMessage: &waE2E.FutureProofMessage{
				Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
					Key:           key("ORIG1"),
					Type:          waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
					EditedMessage: &waE2E.Message{Conversation: strp("fixed the typo")},
				}},
			}},
			wantKind: protocol.KindMessage,
			wantText: "fixed the typo",
			wantEdit: chat + "/ORIG1",
		},
		{
			name: "revoke names its target and is not dropped",
			msg: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
				Key:  key("GONE1"),
				Type: waE2E.ProtocolMessage_REVOKE.Enum(),
			}},
			wantKind:   protocol.KindRevoked,
			wantRevoke: chat + "/GONE1",
		},
		{
			// A type-less ProtocolMessage: only the stanza's edit attribute says what
			// this is, and without a target id the tombstone would be swallowed.
			name: "type-less tombstone survives on the stanza edit attribute",
			msg: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
				Key: key("GONE2"),
			}},
			edit:       types.EditAttributeSenderRevoke,
			wantKind:   protocol.KindRevoked,
			wantRevoke: chat + "/GONE2",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := newTestEngine()
			peer := mustJID(t, chat)
			info := types.MessageInfo{
				ID:            "EDIT1",
				Edit:          tt.edit,
				MessageSource: types.MessageSource{Chat: peer, Sender: peer, IsFromMe: true},
			}
			ev, _, _, ok := e.mapMessage(info, tt.msg)
			if !ok {
				t.Fatal("an edit/revoke that names a target must not be dropped")
			}
			if ev.Kind != tt.wantKind || ev.Text != tt.wantText {
				t.Fatalf("event = (%q, %q), want (%q, %q)", ev.Kind, ev.Text, tt.wantKind, tt.wantText)
			}
			if ev.EditOfExternalID != tt.wantEdit {
				t.Errorf("edit_of_external_id = %q, want %q", ev.EditOfExternalID, tt.wantEdit)
			}
			if ev.RevokeOfExternalID != tt.wantRevoke {
				t.Errorf("revoke_of_external_id = %q, want %q", ev.RevokeOfExternalID, tt.wantRevoke)
			}
		})
	}
}

// TestEditRevokeTarget pins the classification rules on their own, including the
// REVOKE-is-the-zero-value trap that makes an absent type indistinguishable from
// a real revoke through the getter (rich-media-spec §5).
func TestEditRevokeTarget(t *testing.T) {
	withKey := func(t *waE2E.ProtocolMessage_Type) *waE2E.ProtocolMessage {
		return &waE2E.ProtocolMessage{Key: &waCommon.MessageKey{ID: strp("T1")}, Type: t}
	}
	tests := []struct {
		name       string
		pm         *waE2E.ProtocolMessage
		edit       types.EditAttribute
		wantEdit   bool
		wantRevoke bool
	}{
		{name: "no protocol message", pm: nil},
		{name: "keyless revoke targets nothing", pm: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_REVOKE.Enum()}},
		{name: "message edit", pm: withKey(waE2E.ProtocolMessage_MESSAGE_EDIT.Enum()), wantEdit: true},
		{name: "revoke", pm: withKey(waE2E.ProtocolMessage_REVOKE.Enum()), wantRevoke: true},
		{name: "unrelated type with a key targets nothing", pm: withKey(waE2E.ProtocolMessage_HISTORY_SYNC_NOTIFICATION.Enum())},
		{name: "absent type falls back to the edit attribute", pm: withKey(nil), edit: types.EditAttributeMessageEdit, wantEdit: true},
		{name: "absent type and no edit attribute targets nothing", pm: withKey(nil)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			edits, revokes := editRevokeTarget(tt.pm, tt.edit)
			if edits != tt.wantEdit || revokes != tt.wantRevoke {
				t.Fatalf("editRevokeTarget() = (%v, %v), want (%v, %v)", edits, revokes, tt.wantEdit, tt.wantRevoke)
			}
		})
	}
}

// TestContentlessProtocolMessageStillDropped guards the other side of the drop
// rule: a protocol message that names no edit/revoke target is still the
// self-chat "System message" spam and must not leak through (bug 17).
func TestContentlessProtocolMessageStillDropped(t *testing.T) {
	e, _ := newTestEngine()
	peer := mustJID(t, "15551234567@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "SYS2",
		MessageSource: types.MessageSource{Chat: peer, Sender: peer, IsFromMe: true},
	}
	histType := waE2E.ProtocolMessage_HISTORY_SYNC_NOTIFICATION
	msg := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: &histType}}
	if _, _, _, ok := e.mapMessage(info, msg); ok {
		t.Error("a keyless protocol message must still be dropped")
	}
}

// TestReactionRemovalAndEncReaction proves both reaction gaps in
// rich-media-spec §6: a removal (empty text) is still emitted with its target,
// and an encrypted community reaction resolves its target too.
func TestReactionRemovalAndEncReaction(t *testing.T) {
	chat := "15551234567@s.whatsapp.net"
	tests := []struct {
		name string
		msg  *waE2E.Message
	}{
		{
			name: "reaction removal",
			msg: &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
				Key:  &waCommon.MessageKey{ID: strp("TGT1")},
				Text: strp(""),
			}},
		},
		{
			name: "encrypted reaction",
			msg: &waE2E.Message{EncReactionMessage: &waE2E.EncReactionMessage{
				TargetMessageKey: &waCommon.MessageKey{ID: strp("TGT1")},
			}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := newTestEngine()
			peer := mustJID(t, chat)
			info := types.MessageInfo{
				ID:            "REACT1",
				MessageSource: types.MessageSource{Chat: peer, Sender: peer},
			}
			ev, _, _, ok := e.mapMessage(info, tt.msg)
			if !ok {
				t.Fatal("a reaction must never be dropped")
			}
			if ev.Kind != protocol.KindReaction || ev.Text != "" {
				t.Fatalf("event = (%q, %q), want (reaction, \"\")", ev.Kind, ev.Text)
			}
			if ev.ReplyToExternalID != chat+"/TGT1" {
				t.Fatalf("reply_to_external_id = %q, want %q", ev.ReplyToExternalID, chat+"/TGT1")
			}
		})
	}
}

// TestForwardedAndMentions proves is_forwarded and mentioned_ext_ids are read
// off the ContextInfo, with mention JIDs canonicalized so they join against
// actors.source_ext_id (rich-media-spec §2).
func TestForwardedAndMentions(t *testing.T) {
	e, _ := newTestEngine()
	peer := mustJID(t, "15551234567@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "FWD1",
		MessageSource: types.MessageSource{Chat: peer, Sender: peer},
	}
	msg := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: strp("look at this @ann"),
		ContextInfo: &waE2E.ContextInfo{
			IsForwarded:  boolp(true),
			MentionedJID: []string{"15559998888@s.whatsapp.net", "not a jid"},
		},
	}}
	ev, _, _, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("a forwarded message must map")
	}
	if !ev.IsForwarded {
		t.Error("is_forwarded = false, want true")
	}
	if len(ev.MentionedExtIDs) != 1 || ev.MentionedExtIDs[0] != "15559998888@s.whatsapp.net" {
		t.Errorf("mentioned_ext_ids = %v, want the one parseable JID", ev.MentionedExtIDs)
	}

	plain, _, _, _ := e.mapMessage(info, &waE2E.Message{Conversation: strp("hi")})
	if plain.IsForwarded || plain.MentionedExtIDs != nil {
		t.Errorf("plain message carried forward/mention state: %+v", plain)
	}
}

// TestMessageContextInfoCoverage proves a reply carried on any of the types
// messageContextInfo used to miss still surfaces its reply_to
// (rich-media-spec §7).
func TestMessageContextInfoCoverage(t *testing.T) {
	ci := func() *waE2E.ContextInfo { return &waE2E.ContextInfo{StanzaID: strp("Q1")} }

	tests := []struct {
		name string
		msg  *waE2E.Message
	}{
		{"ptv", &waE2E.Message{PtvMessage: &waE2E.VideoMessage{ContextInfo: ci()}}},
		{"live location", &waE2E.Message{LiveLocationMessage: &waE2E.LiveLocationMessage{ContextInfo: ci()}}},
		{"contacts array", &waE2E.Message{ContactsArrayMessage: &waE2E.ContactsArrayMessage{ContextInfo: ci()}}},
		{"group invite", &waE2E.Message{GroupInviteMessage: &waE2E.GroupInviteMessage{ContextInfo: ci()}}},
		{"order", &waE2E.Message{OrderMessage: &waE2E.OrderMessage{ContextInfo: ci()}}},
		{"event", &waE2E.Message{EventMessage: &waE2E.EventMessage{ContextInfo: ci()}}},
		{"album", &waE2E.Message{AlbumMessage: &waE2E.AlbumMessage{ContextInfo: ci()}}},
		{"poll creation", &waE2E.Message{PollCreationMessage: &waE2E.PollCreationMessage{ContextInfo: ci()}}},
		{"poll creation v3", &waE2E.Message{PollCreationMessageV3: &waE2E.PollCreationMessage{ContextInfo: ci()}}},
		{"poll creation v6", &waE2E.Message{PollCreationMessageV6: &waE2E.PollCreationMessage{ContextInfo: ci()}}},
		{
			// V4 and the payment/comment wrappers keep the reply on the message they
			// nest rather than on themselves.
			name: "poll creation v4",
			msg: &waE2E.Message{PollCreationMessageV4: &waE2E.FutureProofMessage{
				Message: &waE2E.Message{PollCreationMessage: &waE2E.PollCreationMessage{ContextInfo: ci()}},
			}},
		},
		{
			name: "comment",
			msg: &waE2E.Message{CommentMessage: &waE2E.CommentMessage{
				Message: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{ContextInfo: ci()}},
			}},
		},
		{
			name: "send payment note",
			msg: &waE2E.Message{SendPaymentMessage: &waE2E.SendPaymentMessage{
				NoteMessage: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{ContextInfo: ci()}},
			}},
		},
		{
			name: "request payment note",
			msg: &waE2E.Message{RequestPaymentMessage: &waE2E.RequestPaymentMessage{
				NoteMessage: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{ContextInfo: ci()}},
			}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := messageContextInfo(tt.msg)
			if got == nil || got.GetStanzaID() != "Q1" {
				t.Fatalf("messageContextInfo() = %v, want the quoted stanza id", got)
			}
		})
	}
}
