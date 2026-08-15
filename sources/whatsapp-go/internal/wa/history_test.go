package wa

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// wrapEphemeral / wrapViewOnceV2 / wrapDeviceSent / wrapEdited wrap an inner
// message in the corresponding container proto so the unwrap tests exercise the
// real accessors (contract §R6.2).
func wrapEphemeral(inner *waE2E.Message) *waE2E.Message {
	return &waE2E.Message{EphemeralMessage: &waE2E.FutureProofMessage{Message: inner}}
}
func wrapViewOnceV2(inner *waE2E.Message) *waE2E.Message {
	return &waE2E.Message{ViewOnceMessageV2: &waE2E.FutureProofMessage{Message: inner}}
}
func wrapDeviceSent(inner *waE2E.Message) *waE2E.Message {
	return &waE2E.Message{DeviceSentMessage: &waE2E.DeviceSentMessage{Message: inner}}
}
func wrapEditedContainer(inner *waE2E.Message) *waE2E.Message {
	return &waE2E.Message{EditedMessage: &waE2E.FutureProofMessage{Message: inner}}
}
func wrapProtocolEdit(inner *waE2E.Message) *waE2E.Message {
	edit := waE2E.ProtocolMessage_MESSAGE_EDIT
	return &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type:          &edit,
		EditedMessage: inner,
	}}
}

// TestUnwrapAndPlainTextFirst is the core contract §R6.2 proof: container
// messages are recursively unwrapped before classifying, and PLAIN text is
// extracted first — so a wrapped plain-text (business) message becomes its REAL
// text, never "[business message]".
func TestUnwrapAndPlainTextFirst(t *testing.T) {
	plain := &waE2E.Message{Conversation: strp("Your OTP is 4821")}

	tests := []struct {
		name string
		msg  *waE2E.Message
		want string
	}{
		{"bare plain", plain, "Your OTP is 4821"},
		{"ephemeral-wrapped plain", wrapEphemeral(plain), "Your OTP is 4821"},
		{"viewonce-v2-wrapped plain", wrapViewOnceV2(plain), "Your OTP is 4821"},
		{"devicesent-wrapped plain", wrapDeviceSent(plain), "Your OTP is 4821"},
		{"edited-container plain", wrapEditedContainer(plain), "Your OTP is 4821"},
		{"protocol-edit plain", wrapProtocolEdit(plain), "Your OTP is 4821"},
		{
			"double-wrapped plain (ephemeral over devicesent)",
			wrapEphemeral(wrapDeviceSent(plain)),
			"Your OTP is 4821",
		},
		{
			"ephemeral-wrapped extended text",
			wrapEphemeral(&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: strp("hello there")}}),
			"hello there",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kind, text, _ := classify(tt.msg)
			if kind != protocol.KindMessage {
				t.Fatalf("kind = %q, want message", kind)
			}
			if text != tt.want {
				t.Fatalf("text = %q, want %q (a wrapped plain msg must NOT be a placeholder)", text, tt.want)
			}
			if text == businessPlaceholder {
				t.Fatalf("wrapped plain text collapsed to the business placeholder (contract §R6.2)")
			}
		})
	}
}

// TestWrappedBusinessPlainTextNotPlaceholder proves a business account that
// simply sends plain text (most OTPs), even when the message is wrapped, ingests
// as the real body — never "[business message]" (contract §R6.2). Exercised
// through mapMessage so the full extraction path is covered.
func TestWrappedBusinessPlainTextNotPlaceholder(t *testing.T) {
	e, _ := newTestEngine()
	biz := mustJID(t, "919538251513@s.whatsapp.net")
	info := types.MessageInfo{
		ID:            "OTP_WRAP_1",
		MessageSource: types.MessageSource{Chat: biz, Sender: biz},
	}
	// A plain OTP text wrapped in an ephemeral container (common for business).
	msg := wrapEphemeral(&waE2E.Message{Conversation: strp("Your JioHome OTP is 4821.")})

	ev, _, _, ok := e.mapMessage(info, msg)
	if !ok {
		t.Fatal("wrapped plain business message must ingest")
	}
	if ev.Kind != protocol.KindMessage {
		t.Fatalf("kind = %q, want message", ev.Kind)
	}
	if ev.Text != "Your JioHome OTP is 4821." {
		t.Fatalf("text = %q, want the real OTP body", ev.Text)
	}
	if ev.Text == businessPlaceholder {
		t.Fatal("business plain text must never be the placeholder (contract §R6.2)")
	}
}

// TestWrappedContainerExposesContextInfo proves a wrapped reply still surfaces
// its quoted ContextInfo (contract §R6.2): messageContextInfo unwraps first.
func TestWrappedContainerExposesContextInfo(t *testing.T) {
	inner := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: strp("Sounds good!"),
		ContextInfo: &waE2E.ContextInfo{
			StanzaID:      strp("ORIG_9"),
			QuotedMessage: &waE2E.Message{Conversation: strp("Meet at 9am.")},
		},
	}}
	wrapped := wrapEphemeral(inner)
	ci := messageContextInfo(wrapped)
	if ci == nil || ci.GetStanzaID() != "ORIG_9" {
		t.Fatalf("messageContextInfo must unwrap containers to reach ContextInfo; got %v", ci)
	}
}

// TestHistorySyncConversationName proves onHistorySync's name recording
// (contract §R6.1): a conversation's own Name/DisplayName becomes the chat name
// for imported chats, so chatName prefers it (used for unsaved businesses whose
// live VerifiedName is empty). No client needed — histChatName short-circuits.
func TestHistorySyncConversationName(t *testing.T) {
	e, _ := newTestEngine()
	otp := mustJID(t, "919538251513@s.whatsapp.net")

	// Extract the name from the proto the way onHistorySync does.
	conv := &waHistorySync.Conversation{Name: strp("JioHome Offers")}
	if got := conversationName(conv); got != "JioHome Offers" {
		t.Fatalf("conversationName = %q, want %q", got, "JioHome Offers")
	}
	// DisplayName fallback when Name is empty.
	convDisp := &waHistorySync.Conversation{DisplayName: strp("Practo AI")}
	if got := conversationName(convDisp); got != "Practo AI" {
		t.Fatalf("conversationName (display) = %q, want %q", got, "Practo AI")
	}

	// Record it, then chatName must prefer it over the number fallback.
	e.setHistChatName(otp, "JioHome Offers")
	info := types.MessageInfo{
		ID:            "OTP_1",
		MessageSource: types.MessageSource{Chat: otp, Sender: otp},
	}
	if got := e.chatName(info, otp); got != "JioHome Offers" {
		t.Fatalf("chatName = %q, want the history-sync name %q", got, "JioHome Offers")
	}

	// A numeric "name" must NOT be recorded (never shadows a real name).
	other := mustJID(t, "15551230000@s.whatsapp.net")
	e.setHistChatName(other, "+15551230000")
	if got := e.histChatName(other); got != "" {
		t.Fatalf("numeric history name should be ignored, got %q", got)
	}
}

// TestHistorySyncPushnameResolution proves HistorySync.Pushnames name actors in
// imported chats (contract §R6.1): absorbPushnames records JID->pushname, and
// actorName uses it when the contact store & live PushName are empty.
func TestHistorySyncPushnameResolution(t *testing.T) {
	e, _ := newTestEngine()
	sender := mustJID(t, "15559998888@s.whatsapp.net")

	hs := &events.HistorySync{Data: &waHistorySync.HistorySync{
		Pushnames: []*waHistorySync.Pushname{
			{ID: strp("15559998888@s.whatsapp.net"), Pushname: strp("Subhashree")},
			{ID: strp("15551112222@s.whatsapp.net"), Pushname: strp("+15551112222")}, // numeric -> ignored
		},
	}}
	e.absorbPushnames(hs)

	if got := e.histPushName(sender); got != "Subhashree" {
		t.Fatalf("histPushName = %q, want %q", got, "Subhashree")
	}
	// Numeric pushname must be ignored.
	numeric := mustJID(t, "15551112222@s.whatsapp.net")
	if got := e.histPushName(numeric); got != "" {
		t.Fatalf("numeric pushname should be ignored, got %q", got)
	}

	// actorName (no client -> no contact/live name) must fall back to the
	// history pushname rather than a bare number.
	info := types.MessageInfo{
		ID:            "M1",
		MessageSource: types.MessageSource{Chat: sender, Sender: sender},
	}
	if got := e.actorName(info, sender); got != "Subhashree" {
		t.Fatalf("actorName = %q, want the history pushname %q", got, "Subhashree")
	}
}

// TestPendingHistoryBufferedUntilRange proves the fix that makes the imported
// window match the user's post-QR selection: an automatic HistorySync that lands
// BEFORE a range is installed is BUFFERED (not filtered by a default), and is
// processed only once Import/SetRange installs the user's chosen range — so that
// range governs the pushed history instead of the daemon default.
func TestPendingHistoryBufferedUntilRange(t *testing.T) {
	e, buf := newTestEngine()
	sender := mustJID(t, "15559998888@s.whatsapp.net")

	hs := &events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_RECENT.Enum(),
		Pushnames: []*waHistorySync.Pushname{
			{ID: strp("15559998888@s.whatsapp.net"), Pushname: strp("Subhashree")},
		},
	}}

	// Automatic history before any range -> buffered, NOT processed.
	e.onHistorySync(hs)
	e.mu.Lock()
	nPending := len(e.pendingHistory)
	e.mu.Unlock()
	if nPending != 1 {
		t.Fatalf("automatic HistorySync before a range must be buffered; pendingHistory=%d, want 1", nPending)
	}
	if got := e.histPushName(sender); got != "" {
		t.Fatalf("buffered history must not be processed yet; histPushName=%q, want empty", got)
	}
	if buf.Len() != 0 {
		t.Fatalf("buffering must emit no frames; got %q", buf.String())
	}

	// Installing the user's range drains the buffer and processes it.
	e.SetRange(protocol.Range7d)
	e.mu.Lock()
	nPending = len(e.pendingHistory)
	e.mu.Unlock()
	if nPending != 0 {
		t.Fatalf("SetRange must drain the buffer; pendingHistory=%d, want 0", nPending)
	}
	if got := e.histPushName(sender); got != "Subhashree" {
		t.Fatalf("after SetRange the buffered batch must be processed; histPushName=%q, want %q", got, "Subhashree")
	}
}

// TestImportDrainsBufferedHistory proves the onboarding path: history buffered
// before the user picks is processed by Import with the chosen range (and Import
// leaves the buffer empty afterward).
func TestImportDrainsBufferedHistory(t *testing.T) {
	e, _ := newTestEngine()
	sender := mustJID(t, "15551230000@s.whatsapp.net")
	hs := &events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_INITIAL_BOOTSTRAP.Enum(),
		Pushnames: []*waHistorySync.Pushname{
			{ID: strp("15551230000@s.whatsapp.net"), Pushname: strp("Ravi")},
		},
	}}
	e.onHistorySync(hs)
	e.mu.Lock()
	buffered := len(e.pendingHistory)
	e.mu.Unlock()
	if buffered != 1 {
		t.Fatalf("pre-range history must buffer; pendingHistory=%d, want 1", buffered)
	}

	e.Import(protocol.Range90d)

	e.mu.Lock()
	nPending := len(e.pendingHistory)
	gotRange := e.importRange
	e.mu.Unlock()
	if nPending != 0 {
		t.Fatalf("Import must drain the buffer; pendingHistory=%d, want 0", nPending)
	}
	if gotRange != protocol.Range90d {
		t.Fatalf("Import must install its range; importRange=%q, want 90d", gotRange)
	}
	if got := e.histPushName(sender); got != "Ravi" {
		t.Fatalf("Import must process the buffered batch; histPushName=%q, want %q", got, "Ravi")
	}
}

// TestImportDrainsBufferBeforeStartingRun proves the buffered post-pairing
// bootstrap is drained with backfill.active==false (BEFORE resetBackfill starts
// the run), so it ingests + records anchors but does NOT count toward or complete
// the run. If it drained inside the active run, a recent batch reporting
// server-complete progress (~100% of the transfer, not of the chosen range) would
// fire backfill_complete and clear the import banner before the paginator widens
// to the full range. noteHistoryBatch only bumps `batches` while active, so a
// post-Import batches>0 would betray the wrong ordering.
func TestImportDrainsBufferBeforeStartingRun(t *testing.T) {
	e, _ := newTestEngine()
	prog := uint32(100) // server-complete: would fire completion if drained active

	for i := 0; i < 2; i++ {
		e.onHistorySync(&events.HistorySync{Data: &waHistorySync.HistorySync{
			SyncType: waHistorySync.HistorySync_RECENT.Enum(),
			Progress: &prog,
		}})
	}
	e.mu.Lock()
	nBuf := len(e.pendingHistory)
	e.mu.Unlock()
	if nBuf != 2 {
		t.Fatalf("pre-range history must buffer; pendingHistory=%d, want 2", nBuf)
	}

	e.Import(protocol.Range1y)

	e.mu.Lock()
	nBuf = len(e.pendingHistory)
	e.mu.Unlock()
	if nBuf != 0 {
		t.Fatalf("Import must drain the buffer; pendingHistory=%d, want 0", nBuf)
	}
	// active==false during the drain -> noteHistoryBatch never incremented batches.
	e.backfill.mu.Lock()
	batches := e.backfill.batches
	e.backfill.mu.Unlock()
	if batches != 0 {
		t.Fatalf("buffered bootstrap must drain BEFORE the run starts (active==false); backfill.batches=%d, want 0", batches)
	}
}

// TestOnDemandHistoryNotBuffered proves ON_DEMAND (paginator) batches are never
// buffered even before a range is installed — only the automatic post-pairing
// push is held for the range selection.
func TestOnDemandHistoryNotBuffered(t *testing.T) {
	e, _ := newTestEngine()
	hs := &events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_ON_DEMAND.Enum(),
	}}
	e.onHistorySync(hs)
	e.mu.Lock()
	nPending := len(e.pendingHistory)
	e.mu.Unlock()
	if nPending != 0 {
		t.Fatalf("ON_DEMAND history must not be buffered; pendingHistory=%d, want 0", nPending)
	}
}

// TestHistoryEventsAreMarkedHistorical proves the one signal that tells an import
// apart from live traffic (v4-spec §4b). onEvent is the worker's single entry
// point for both, and nothing on the wire distinguishes them, so every imported
// row looked like an arrival that had to jump the media queue — which collapsed
// the queue to one row per batch for the whole import. Both an imported message
// and the reactions that ride on it must carry the flag; a live arrival must not.
func TestHistoryEventsAreMarkedHistorical(t *testing.T) {
	at := time.Now().Add(-time.Hour)
	chat := "15551234567@s.whatsapp.net"

	e, buf := newTestEngine()
	e.parseWebMsgFn = func(c types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error) {
		return &events.Message{
			Info: types.MessageInfo{
				ID:            webMsg.GetKey().GetID(),
				Timestamp:     at,
				MessageSource: types.MessageSource{Chat: c, Sender: c},
			},
			Message:      &waE2E.Message{Conversation: strp("dinner at 8?")},
			SourceWebMsg: webMsg,
		}, nil
	}
	e.SetRange(protocol.Range7d)

	e.processHistorySync(&events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_RECENT.Enum(),
		Conversations: []*waHistorySync.Conversation{{
			ID:               strp(chat),
			LastMsgTimestamp: u64p(uint64(at.Unix())),
			Messages: []*waHistorySync.HistorySyncMsg{{Message: &waWeb.WebMessageInfo{
				Key:              &waCommon.MessageKey{ID: strp("MSG1"), RemoteJID: strp(chat)},
				MessageTimestamp: u64p(uint64(at.Unix())),
				Reactions: []*waWeb.Reaction{{
					Key:               reactionKey("RX1", "", false),
					Text:              strp("👍"),
					SenderTimestampMS: i64p(at.UnixMilli()),
				}},
			}}},
		}},
	}})

	// A genuinely live arrival through the same mapper.
	peer := mustJID(t, chat)
	e.onMessage(&events.Message{
		Info: types.MessageInfo{
			ID:            "LIVE1",
			Timestamp:     time.Now(),
			MessageSource: types.MessageSource{Chat: peer, Sender: peer},
		},
		Message: &waE2E.Message{Conversation: strp("on my way")},
	})

	got := map[string]bool{}
	for _, line := range decodeLines(t, buf) {
		if line["t"] != "event" {
			continue
		}
		ev := line["event"].(map[string]any)
		got[ev["external_id"].(string)] = ev["is_historical"] == true
	}
	for id, want := range map[string]bool{
		chat + "/MSG1":  true,
		chat + "/RX1":   true,
		chat + "/LIVE1": false,
	} {
		if seen, ok := got[id]; !ok {
			t.Errorf("no event emitted for %s", id)
		} else if seen != want {
			t.Errorf("%s is_historical = %v, want %v", id, seen, want)
		}
	}
}

// TestHistoryIsReplayedOldestFirst proves an imported conversation reaches the
// worker in the order it was written. WhatsApp hands one back NEWEST-FIRST —
// verified on the live DB — and every backward reference the daemon emits (a
// reply, an edit, a revoke, a reaction) names a message by external_id, so
// replaying it as delivered puts each of them on the stream ahead of the row it
// has to fold into.
func TestHistoryIsReplayedOldestFirst(t *testing.T) {
	chat := "918884542333@s.whatsapp.net"
	base := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	// Newest first, exactly as WhatsApp delivers it.
	delivered := []struct {
		id string
		at time.Time
	}{
		{"THIRD", base.Add(2 * time.Minute)},
		{"SECOND", base.Add(time.Minute)},
		{"FIRST", base},
	}

	e, buf := newTestEngine()
	at := map[string]time.Time{}
	for _, d := range delivered {
		at[d.id] = d.at
	}
	e.parseWebMsgFn = func(c types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error) {
		id := webMsg.GetKey().GetID()
		return &events.Message{
			Info: types.MessageInfo{
				ID:            id,
				Timestamp:     at[id],
				MessageSource: types.MessageSource{Chat: c, Sender: c},
			},
			Message:      &waE2E.Message{Conversation: strp(id)},
			SourceWebMsg: webMsg,
		}, nil
	}
	e.SetRange(protocol.Range7d)

	var histMsgs []*waHistorySync.HistorySyncMsg
	for _, d := range delivered {
		histMsgs = append(histMsgs, &waHistorySync.HistorySyncMsg{Message: &waWeb.WebMessageInfo{
			Key:              &waCommon.MessageKey{ID: strp(d.id), RemoteJID: strp(chat)},
			MessageTimestamp: u64p(uint64(d.at.Unix())),
		}})
	}
	e.processHistorySync(&events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_RECENT.Enum(),
		Conversations: []*waHistorySync.Conversation{{
			ID:               strp(chat),
			LastMsgTimestamp: u64p(uint64(base.Add(3 * time.Minute).Unix())),
			Messages:         histMsgs,
		}},
	}})

	var order []string
	for _, line := range decodeLines(t, buf) {
		if line["t"] != "event" {
			continue
		}
		ev := line["event"].(map[string]any)
		order = append(order, ev["external_id"].(string))
	}
	want := []string{chat + "/FIRST", chat + "/SECOND", chat + "/THIRD"}
	if len(order) != len(want) {
		t.Fatalf("emitted %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("emitted %v, want %v", order, want)
		}
	}
}
