package wa

import (
	"testing"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waVnameCert"
	"go.mau.fi/whatsmeow/types"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

func boolp(b bool) *bool { return &b }

// TestBusinessTextNeverBareTemplatePlaceholder is the contract §R5.2 guarantee:
// NO message may surface the literal "[template message]". Every business
// message type either yields real text or, when genuinely empty, the short
// non-bare placeholder — never "[template message]".
func TestBusinessTextNeverBareTemplatePlaceholder(t *testing.T) {
	msgs := []*waE2E.Message{
		{TemplateMessage: &waE2E.TemplateMessage{}},
		{TemplateMessage: &waE2E.TemplateMessage{HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{}}},
		{ListMessage: &waE2E.ListMessage{}},
		{ButtonsMessage: &waE2E.ButtonsMessage{}},
		{InteractiveMessage: &waE2E.InteractiveMessage{}},
		{ProductMessage: &waE2E.ProductMessage{}},
		{OrderMessage: &waE2E.OrderMessage{}},
	}
	for _, m := range msgs {
		got := businessText(m)
		if got == "" {
			t.Errorf("businessText returned empty for a business message type: %T", m)
		}
		if got == "[template message]" {
			t.Errorf("businessText surfaced the forbidden bare placeholder for %T (contract §R5.2)", m)
		}
	}
}

// TestVerifiedNameResolution proves an unsaved business/OTP sender resolves its
// name from the message's VerifiedName field (contract §R5.2, bug 2) for BOTH
// the channel name and the actor display_name — instead of a bare number. The
// test engine has no contact store, so VerifiedName is the only source.
func TestVerifiedNameResolution(t *testing.T) {
	e, _ := newTestEngine()
	bizJID := mustJID(t, "15551112222@s.whatsapp.net")

	info := types.MessageInfo{
		ID: "BIZ_VN_1",
		MessageSource: types.MessageSource{
			Chat:   bizJID,
			Sender: bizJID,
		},
		VerifiedName: &types.VerifiedName{
			Details: &waVnameCert.VerifiedNameCertificate_Details{
				VerifiedName: strp("Acme Support"),
			},
		},
	}
	// A template with real body text so it ingests as a normal message.
	msg := &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
		HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
			HydratedContentText: strp("Your OTP is 4821."),
		},
	}}

	ev, ch, ac, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("business template message must ingest")
	}
	if ev.Text != "Your OTP is 4821." {
		t.Fatalf("business template text = %q, want the real hydrated body", ev.Text)
	}
	if ch.Name != "Acme Support" {
		t.Fatalf("channel name = %q, want verified name %q", ch.Name, "Acme Support")
	}
	if ac.DisplayName != "Acme Support" {
		t.Fatalf("actor display_name = %q, want verified name %q", ac.DisplayName, "Acme Support")
	}
}

// TestVerifiedNameHelper is a focused unit check on the accessor path
// info.VerifiedName.Details.GetVerifiedName().
func TestVerifiedNameHelper(t *testing.T) {
	if got := verifiedName(types.MessageInfo{}); got != "" {
		t.Errorf("verifiedName(zero) = %q, want empty", got)
	}
	info := types.MessageInfo{VerifiedName: &types.VerifiedName{
		Details: &waVnameCert.VerifiedNameCertificate_Details{VerifiedName: strp("Bank XYZ")},
	}}
	if got := verifiedName(info); got != "Bank XYZ" {
		t.Errorf("verifiedName = %q, want %q", got, "Bank XYZ")
	}
}

// TestReactionMapping proves a ReactionMessage becomes its OWN event
// (kind=reaction) with reply_to_external_id = the TARGET message's external_id
// and text = the emoji; an empty-text reaction (removal) is still emitted with
// empty text (contract §R5.3, bug 3a).
func TestReactionMapping(t *testing.T) {
	e, _ := newTestEngine()
	chat := mustJID(t, "15551234567@s.whatsapp.net")

	mk := func(text string) (types.MessageInfo, *waE2E.Message) {
		info := types.MessageInfo{
			ID:            "REACT_1",
			MessageSource: types.MessageSource{Chat: chat, Sender: chat},
		}
		msg := &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
			Key: &waCommon.MessageKey{
				ID:        strp("TARGET_123"),
				RemoteJID: strp("15551234567@s.whatsapp.net"),
				FromMe:    boolp(false),
			},
			Text: strp(text),
		}}
		return info, msg
	}

	// A real emoji reaction.
	info, msg := mk("👍")
	ev, _, _, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("reaction must NOT be dropped (contract §R5.3)")
	}
	if ev.Kind != protocol.KindReaction {
		t.Fatalf("reaction kind = %q, want %q", ev.Kind, protocol.KindReaction)
	}
	if ev.Text != "👍" {
		t.Fatalf("reaction text = %q, want the emoji", ev.Text)
	}
	wantTarget := "15551234567@s.whatsapp.net/TARGET_123"
	if ev.ReplyToExternalID != wantTarget {
		t.Fatalf("reaction reply_to_external_id = %q, want %q", ev.ReplyToExternalID, wantTarget)
	}

	// Reaction removal (empty text) is still emitted with the same target.
	info, msg = mk("")
	ev, _, _, ok = e.mapMessage(info, msg)
	if !ok {
		t.Fatal("reaction removal must NOT be dropped")
	}
	if ev.Kind != protocol.KindReaction || ev.Text != "" {
		t.Fatalf("reaction removal = (%q, %q), want (reaction, empty)", ev.Kind, ev.Text)
	}
	if ev.ReplyToExternalID != wantTarget {
		t.Fatalf("reaction removal target = %q, want %q", ev.ReplyToExternalID, wantTarget)
	}
}

// TestReactionTargetFallsBackToOwnChat proves that when the ReactionMessage.Key
// has no RemoteJID (common for same-chat reactions), the target resolves in the
// reaction's own (canonical) chat.
func TestReactionTargetFallsBackToOwnChat(t *testing.T) {
	e, _ := newTestEngine()
	chat := mustJID(t, "15551234567@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "REACT_2",
		MessageSource: types.MessageSource{Chat: chat, Sender: chat},
	}
	msg := &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{
		Key:  &waCommon.MessageKey{ID: strp("TARGET_456")}, // no RemoteJID
		Text: strp("❤️"),
	}}
	ev, _, _, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("reaction must ingest")
	}
	want := "15551234567@s.whatsapp.net/TARGET_456"
	if ev.ReplyToExternalID != want {
		t.Fatalf("reaction target = %q, want same-chat target %q", ev.ReplyToExternalID, want)
	}
}

// TestQuotedReplyExtraction proves a message that quotes another populates
// reply_to = {external_id, text, actor_ext_id} using the ContextInfo StanzaID /
// QuotedMessage / Participant (contract §R5.4, bug 3b). The quoted text is
// extracted with the same extractor as top-level messages.
func TestQuotedReplyExtraction(t *testing.T) {
	e, _ := newTestEngine()
	group := mustJID(t, "120363000000000001@g.us")
	sender := mustJID(t, "15559876543@s.whatsapp.net") // Alice replies
	quotedAuthor := "15550002222@s.whatsapp.net"       // Bob was quoted

	info := types.MessageInfo{
		ID: "REPLY_1",
		MessageSource: types.MessageSource{
			Chat:    group,
			Sender:  sender,
			IsGroup: true,
		},
	}
	msg := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: strp("Sounds good!"),
		ContextInfo: &waE2E.ContextInfo{
			StanzaID:      strp("BOB_ORIG_9"),
			Participant:   strp(quotedAuthor),
			QuotedMessage: &waE2E.Message{Conversation: strp("Meet at 9am.")},
		},
	}}

	ev, _, _, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("reply message must ingest")
	}
	if ev.Text != "Sounds good!" {
		t.Fatalf("reply body = %q, want the reply text", ev.Text)
	}
	if ev.ReplyTo == nil {
		t.Fatal("reply_to must be populated for a quoted reply (contract §R5.4)")
	}
	// Chat defaults to the reply's own chat (the group), so external_id ties to it.
	wantExt := "120363000000000001@g.us/BOB_ORIG_9"
	if ev.ReplyTo.ExternalID != wantExt {
		t.Fatalf("reply_to.external_id = %q, want %q", ev.ReplyTo.ExternalID, wantExt)
	}
	if ev.ReplyTo.Text != "Meet at 9am." {
		t.Fatalf("reply_to.text = %q, want the quoted text", ev.ReplyTo.Text)
	}
	if ev.ReplyTo.ActorExtID != quotedAuthor {
		t.Fatalf("reply_to.actor_ext_id = %q, want %q", ev.ReplyTo.ActorExtID, quotedAuthor)
	}
}

// TestNonReplyHasNilReplyTo proves a plain message (no ContextInfo) leaves
// reply_to nil, and a non-reaction message leaves reply_to_external_id empty.
func TestNonReplyHasNilReplyTo(t *testing.T) {
	e, _ := newTestEngine()
	chat := mustJID(t, "15551234567@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "PLAIN_1",
		MessageSource: types.MessageSource{Chat: chat, Sender: chat},
	}
	ev, _, _, ok := e.mapMessage(info, &waE2E.Message{Conversation: strp("hi")})
	if !ok {
		t.Fatal("plain message must ingest")
	}
	if ev.ReplyTo != nil {
		t.Fatalf("plain message reply_to = %+v, want nil", ev.ReplyTo)
	}
	if ev.ReplyToExternalID != "" {
		t.Fatalf("plain message reply_to_external_id = %q, want empty", ev.ReplyToExternalID)
	}
}

// TestQuotedReplyOnMediaMessage proves the reply ContextInfo is also picked up
// from a media message (not just ExtendedText), and the quoted business
// template's real text is extracted. Tested at the quotedReplyTo/
// messageContextInfo level to avoid mapMessage's live media-download path.
func TestQuotedReplyOnMediaMessage(t *testing.T) {
	e, _ := newTestEngine()
	chat := mustJID(t, "15551234567@s.whatsapp.net")
	// An image reply quoting a business template message.
	msg := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption:  strp("like this?"),
		Mimetype: strp("image/jpeg"),
		ContextInfo: &waE2E.ContextInfo{
			StanzaID:    strp("TPL_ORIG_1"),
			Participant: strp("15551234567@s.whatsapp.net"),
			QuotedMessage: &waE2E.Message{TemplateMessage: &waE2E.TemplateMessage{
				HydratedTemplate: &waE2E.TemplateMessage_HydratedFourRowTemplate{
					HydratedContentText: strp("Your order shipped."),
				},
			}},
		},
	}}

	// The context info must be discoverable on the image carrier.
	ci := messageContextInfo(msg)
	if ci == nil || ci.GetStanzaID() != "TPL_ORIG_1" {
		t.Fatal("messageContextInfo must read ContextInfo off an ImageMessage")
	}

	c := e.newCanonicalizer()
	rt := e.quotedReplyTo(c, ci, chat)
	if rt == nil {
		t.Fatal("reply_to must be populated for an image reply")
	}
	if rt.ExternalID != "15551234567@s.whatsapp.net/TPL_ORIG_1" {
		t.Fatalf("reply_to.external_id = %q, want the quoted target", rt.ExternalID)
	}
	if rt.Text != "Your order shipped." {
		t.Fatalf("quoted business text = %q, want extracted template body", rt.Text)
	}
}
