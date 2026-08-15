package wa

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

func strp(s string) *string { return &s }

// TestClassifyBusinessMessageTypes proves the mapper extracts display text from
// business / non-plain message types (contract §R4.2, bug 16) so they ingest as
// kind `message` instead of being dropped ("No messages" on business chats).
func TestClassifyBusinessMessageTypes(t *testing.T) {
	tests := []struct {
		name     string
		msg      *waE2E.Message
		wantKind protocol.Kind
		wantText string
	}{
		{
			name: "template hydrated content text",
			msg: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
					HydratedContentText: strp("Your order #4821 has shipped."),
				},
			}},
			wantKind: protocol.KindMessage,
			wantText: "Your order #4821 has shipped.",
		},
		{
			name: "template falls back to title",
			msg: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
					Title: &waE2E.TemplateMessage_HydratedFourRowTemplate_HydratedTitleText{
						HydratedTitleText: "Order update",
					},
				},
			}},
			wantKind: protocol.KindMessage,
			wantText: "Order update",
		},
		{
			// A genuinely empty template still ingests, but the placeholder MUST
			// NOT be the literal "[template message]" the UI flagged (contract
			// §R5.2, bug 2). See TestBusinessTextNeverBareTemplatePlaceholder.
			name:     "empty template still ingests with non-bare placeholder",
			msg:      &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{}},
			wantKind: protocol.KindMessage,
			wantText: businessPlaceholder,
		},
		{
			// Non-hydrated FourRowTemplate: real text lives in the Content
			// HighlyStructuredMessage's localizable-param defaults (contract §R5.2).
			name: "non-hydrated four-row template content",
			msg: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				Format: &waE2E.TemplateMessage_FourRowTemplate_{
					FourRowTemplate: &waE2E.TemplateMessage_FourRowTemplate{
						Content: &waE2E.HighlyStructuredMessage{
							LocalizableParams: []*waE2E.HighlyStructuredMessage_HSMLocalizableParameter{
								{Default: strp("Your appointment is confirmed")},
							},
						},
					},
				},
			}},
			wantKind: protocol.KindMessage,
			wantText: "Your appointment is confirmed",
		},
		{
			name: "list message description",
			msg: &waE2E.Message{ListMessage: &waE2E.ListMessage{
				Description: strp("Pick a slot"),
				Title:       strp("Booking"),
			}},
			wantKind: protocol.KindMessage,
			wantText: "Pick a slot",
		},
		{
			name: "buttons content text",
			msg: &waE2E.Message{ButtonsMessage: &waE2E.ButtonsMessage{
				ContentText: strp("Choose an option"),
			}},
			wantKind: protocol.KindMessage,
			wantText: "Choose an option",
		},
		{
			name: "interactive body",
			msg: &waE2E.Message{InteractiveMessage: &waE2E.InteractiveMessage{
				Body: &waE2E.InteractiveMessage_Body{Text: strp("Interactive body")},
			}},
			wantKind: protocol.KindMessage,
			wantText: "Interactive body",
		},
		{
			name: "product body",
			msg: &waE2E.Message{ProductMessage: &waE2E.ProductMessage{
				Body: strp("Buy the widget"),
			}},
			wantKind: protocol.KindMessage,
			wantText: "Buy the widget",
		},
		{
			name: "order message",
			msg: &waE2E.Message{OrderMessage: &waE2E.OrderMessage{
				Message: strp("2 items ordered"),
			}},
			wantKind: protocol.KindMessage,
			wantText: "2 items ordered",
		},
		{
			name: "template button reply",
			msg: &waE2E.Message{TemplateButtonReplyMessage: &waE2E.TemplateButtonReplyMessage{
				SelectedDisplayText: strp("Yes, confirm"),
			}},
			wantKind: protocol.KindMessage,
			wantText: "Yes, confirm",
		},
		{
			name: "list response",
			msg: &waE2E.Message{ListResponseMessage: &waE2E.ListResponseMessage{
				Title: strp("Slot A"),
			}},
			wantKind: protocol.KindMessage,
			wantText: "Slot A",
		},
		{
			name: "buttons response",
			msg: &waE2E.Message{ButtonsResponseMessage: &waE2E.ButtonsResponseMessage{
				Response: &waE2E.ButtonsResponseMessage_SelectedDisplayText{
					SelectedDisplayText: "Option 2",
				},
			}},
			wantKind: protocol.KindMessage,
			wantText: "Option 2",
		},
		{
			name: "interactive response body",
			msg: &waE2E.Message{InteractiveResponseMessage: &waE2E.InteractiveResponseMessage{
				Body: &waE2E.InteractiveResponseMessage_Body{Text: strp("Reply body")},
			}},
			wantKind: protocol.KindMessage,
			wantText: "Reply body",
		},
		{
			// Plain text still works (regression guard).
			name:     "plain conversation",
			msg:      &waE2E.Message{Conversation: strp("hello")},
			wantKind: protocol.KindMessage,
			wantText: "hello",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kind, text, _ := classify(tt.msg)
			if kind != tt.wantKind || text != tt.wantText {
				t.Fatalf("classify() = (%q, %q), want (%q, %q)", kind, text, tt.wantKind, tt.wantText)
			}
		})
	}
}

// TestSkipChatJID proves the noise-JID filter (contract §R4.3, bug 17): status,
// newsletter, and broadcast JIDs are skipped; normal groups/DMs are kept.
func TestSkipChatJID(t *testing.T) {
	tests := []struct {
		jid  string
		skip bool
	}{
		{"status@broadcast", true},
		{"120363111111111111@newsletter", true},
		{"1234567890@broadcast", true},
		{"120363000000000001@g.us", false},    // normal group kept
		{"15551234567@s.whatsapp.net", false}, // DM kept
		{"22221111@lid", false},               // LID DM kept
	}
	for _, tt := range tests {
		j := mustJID(t, tt.jid)
		if got := skipChatJID(j); got != tt.skip {
			t.Fatalf("skipChatJID(%q) = %v, want %v", tt.jid, got, tt.skip)
		}
	}
}

// TestMapMessageDropsNoiseAndContentlessSystem proves mapMessage returns ok=false
// for (a) messages in noise chats and (b) contentless system/protocol messages
// (the self-chat "System message" spam), while KEEPING real messages
// (contract §R4.3, bug 17).
func TestMapMessageDropsNoiseAndContentlessSystem(t *testing.T) {
	e, _ := newTestEngine()

	// Contentless protocol message (no text, no media) -> dropped. Use a
	// non-revoke type (HISTORY_SYNC_NOTIFICATION) so it maps to kind system, not
	// the legitimate revoke path. This is exactly the self-chat "System message"
	// spam (bug 17).
	histType := waE2E.ProtocolMessage_HISTORY_SYNC_NOTIFICATION
	protoMsg := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: &histType}}
	selfChat := mustJID(t, "15550000001@s.whatsapp.net")
	info := types.MessageInfo{
		ID: "SYS1",
		MessageSource: types.MessageSource{
			Chat:     selfChat,
			Sender:   selfChat,
			IsFromMe: true,
		},
	}
	if _, _, _, ok := e.mapMessage(info, protoMsg); ok {
		t.Error("contentless protocol message should be dropped (bug 17)")
	}

	// Status broadcast message -> dropped regardless of content.
	statusChat := mustJID(t, "status@broadcast")
	statusInfo := types.MessageInfo{
		ID:            "ST1",
		MessageSource: types.MessageSource{Chat: statusChat, Sender: mustJID(t, "15559876543@s.whatsapp.net")},
	}
	if _, _, _, ok := e.mapMessage(statusInfo, &waE2E.Message{Conversation: strp("status text")}); ok {
		t.Error("status@broadcast message should be dropped (bug 17)")
	}

	// A real DM message -> kept.
	dmChat := mustJID(t, "15551234567@s.whatsapp.net")
	dmInfo := types.MessageInfo{
		ID:            "MOM1",
		MessageSource: types.MessageSource{Chat: dmChat, Sender: dmChat},
	}
	if _, _, _, ok := e.mapMessage(dmInfo, &waE2E.Message{Conversation: strp("hi")}); !ok {
		t.Error("real DM message must NOT be dropped")
	}
}

// TestAlbumHeaderIsDropped proves the header WhatsApp sends ahead of a photo
// burst produces no event at all (v7-spec §1). It used to ingest as a bodyless
// kind:message so it could carry the grouping; with the grouping removed that row
// is a blank message above photos that already stand on their own. AlbumMessage
// carries only two expected counts — which WhatsApp leaves unset — so dropping it
// loses nothing a person wrote. The photos behind it arrive as their own
// AssociatedChildMessage-wrapped images and must still ingest.
func TestAlbumHeaderIsDropped(t *testing.T) {
	e, _ := newTestEngine()
	e.mediaDir = t.TempDir()
	chat := mustJID(t, "120363000000000042@g.us")
	sender := mustJID(t, "15551234567@s.whatsapp.net")
	info := func(id string) types.MessageInfo {
		return types.MessageInfo{
			ID:            id,
			Timestamp:     time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC),
			MessageSource: types.MessageSource{Chat: chat, Sender: sender},
		}
	}

	if _, _, _, ok := e.mapMessage(info("HDR"), &waE2E.Message{AlbumMessage: &waE2E.AlbumMessage{}}); ok {
		t.Error("an album header must be dropped, not emitted as a blank message")
	}
	// A header that DOES state its counts is still only an announcement.
	counted := &waE2E.Message{AlbumMessage: &waE2E.AlbumMessage{
		ExpectedImageCount: u32p(2),
		ExpectedVideoCount: u32p(1),
	}}
	if _, _, _, ok := e.mapMessage(info("HDR2"), counted); ok {
		t.Error("an album header stating counts must still be dropped")
	}

	child := &waE2E.Message{AssociatedChildMessage: &waE2E.FutureProofMessage{
		Message: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Mimetype: strp("image/jpeg")}},
	}}
	ev, _, _, ok := e.mapMessage(info("P1"), child)
	if !ok {
		t.Fatal("an album photo must ingest as an ordinary image")
	}
	if ev.Kind != protocol.KindImage {
		t.Errorf("album photo kind = %q, want image", ev.Kind)
	}
}

// TestBusinessDeepExtraction proves the r7 deeper business-text extraction
// (contract §R5.2, bug 1): modern HSM/template OTPs (nested HydratedHsm),
// button-only templates, and payment/comment wrappers now yield real text
// instead of the "[business message]" placeholder.
func TestBusinessDeepExtraction(t *testing.T) {
	tests := []struct {
		name string
		msg  *waE2E.Message
		want string
	}{
		{
			// RANK 1: modern HSM/template OTP carries text in a NESTED TemplateMessage
			// (HydratedHsm), not in localizable params — must recurse (the Jio case).
			name: "highly-structured hydrated HSM recursion",
			msg: &waE2E.Message{HighlyStructuredMessage: &waE2E.HighlyStructuredMessage{
				HydratedHsm: &waE2E.TemplateMessage{
					HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
						HydratedContentText: strp("Your OTP is 4821. Valid 10 min."),
					},
				},
			}},
			want: "Your OTP is 4821. Valid 10 min.",
		},
		{
			// The Jio/OTP case (wa-diag.log dominant, 49×): the hydrated four-row
			// template arrives via the Format ONEOF (HydratedFourRowTemplate), which
			// GetHydratedTemplate() (the separate field) misses.
			name: "template via HydratedFourRowTemplate oneof",
			msg: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				Format: &waE2E.TemplateMessage_HydratedFourRowTemplate_{
					HydratedFourRowTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
						HydratedContentText: strp("Your Jio OTP is 8891."),
					},
				},
			}},
			want: "Your Jio OTP is 8891.",
		},
		{
			// wa-diag.log: unhandled field=AssociatedChildMessage (15×) — album
			// items / thread children were dropped; now unwrapped to inner content.
			name: "associated child message unwraps to inner text",
			msg: &waE2E.Message{AssociatedChildMessage: &waE2E.FutureProofMessage{
				Message: &waE2E.Message{Conversation: strp("album caption")},
			}},
			want: "album caption",
		},
		{
			// RANK 2: a template whose only text is on a quick-reply button.
			name: "template hydrated button display text",
			msg: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
					HydratedButtons: []*waE2E.HydratedTemplateButton{
						{HydratedButton: &waE2E.HydratedTemplateButton_QuickReplyButton{
							QuickReplyButton: &waE2E.HydratedTemplateButton_HydratedQuickReplyButton{
								DisplayText: strp("Track order"),
							},
						}},
					},
				},
			}},
			want: "Track order",
		},
		{
			// RANK 5: a payment note carries a NESTED plain-text Message.
			name: "send-payment note message",
			msg: &waE2E.Message{SendPaymentMessage: &waE2E.SendPaymentMessage{
				NoteMessage: &waE2E.Message{Conversation: strp("Paid for lunch")},
			}},
			want: "Paid for lunch",
		},
		{
			// RANK 5: a comment carries a NESTED plain-text Message.
			name: "comment message",
			msg: &waE2E.Message{CommentMessage: &waE2E.CommentMessage{
				Message: &waE2E.Message{Conversation: strp("great post!")},
			}},
			want: "great post!",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kind, text, _ := classify(tt.msg)
			if kind != protocol.KindMessage || text != tt.want {
				t.Fatalf("classify() = (%q, %q), want (message, %q)", kind, text, tt.want)
			}
		})
	}
}

// TestMaskedPushNameEmitsEmptyName proves the info.PushName masked/numeric guard
// (contract §R7.3) combined with the empty-name emission (bug: RC1, contract §3):
// a WhatsApp privacy-masked live push name must NOT become the chat/actor name,
// and — since no REAL name is known — the daemon now emits an EMPTY name rather
// than pinning the number as the identity. The number is still carried via the
// actor Handle and via source_ext_id (the JID) so the frontend pretty-prints it.
func TestMaskedPushNameEmitsEmptyName(t *testing.T) {
	e, _ := newTestEngine() // no client → contactName/hist names empty
	peer := mustJID(t, "919538251513@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "M1",
		PushName:      "+91∙∙∙∙∙∙∙∙13", // WhatsApp privacy-masked push name
		MessageSource: types.MessageSource{Chat: peer, Sender: peer},
	}
	_, ch, ac, ok := e.mapMessage(info, &waE2E.Message{Conversation: strp("hi")})
	if !ok {
		t.Fatal("real DM message must map")
	}
	if ch.Name != "" {
		t.Errorf("channel name = %q, want empty (masked push name rejected → empty, not the number)", ch.Name)
	}
	if ch.SourceExtID != peer.String() {
		t.Errorf("channel source_ext_id = %q, want %q (carries JID for pretty-print)", ch.SourceExtID, peer.String())
	}
	if ac.DisplayName != "" {
		t.Errorf("actor name = %q, want empty (masked push name rejected → empty, not the number)", ac.DisplayName)
	}
	// The handle still carries the phone number for the frontend fallback.
	if ac.Handle != "+919538251513" {
		t.Errorf("actor handle = %q, want +919538251513 (number carried via Handle)", ac.Handle)
	}
	if ac.SourceExtID != peer.String() {
		t.Errorf("actor source_ext_id = %q, want %q (carries JID for pretty-print)", ac.SourceExtID, peer.String())
	}
}
