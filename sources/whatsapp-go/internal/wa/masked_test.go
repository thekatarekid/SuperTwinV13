package wa

import (
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// TestIsMaskedNumberLabel proves the WhatsApp privacy-mask detector (contract
// §R7.3): masked phone numbers (asterisks/bullets/mid-dots) are recognized so
// they are never stored/shown as a name, while real names and plain numbers are
// NOT misclassified.
func TestIsMaskedNumberLabel(t *testing.T) {
	masked := []string{
		"+91········15",     // mid-dots (the reported form)
		"+91••••••15",       // bullets
		"+91 ***** **015",   // asterisks, the "stars" the user saw
		"**********",        // all stars
		"··········",        // all mid-dots
		"~ ••15",            // pushname-style masked tail
		"+1 (555) ***-**67", // separators + stars
	}
	for _, s := range masked {
		if !isMaskedNumberLabel(s) {
			t.Errorf("isMaskedNumberLabel(%q) = false, want true", s)
		}
		// A masked value must also count as a number-label so it is never stored
		// as a display name / preferred over a real one.
		if !looksLikeNumberLabel(s) {
			t.Errorf("looksLikeNumberLabel(%q) = false, want true (masked is number-ish)", s)
		}
	}

	real := []string{
		"Mom",
		"Acme Support",
		"JioHome Offers",
		"+919731006976", // plain number, no mask glyphs
		"919731006976",
		"J.R.",       // initials: has letters -> a real name
		"24.7 Diner", // one dot, has letters -> not masked
		"A*",         // single star, has a letter -> not masked
	}
	for _, s := range real {
		if isMaskedNumberLabel(s) {
			t.Errorf("isMaskedNumberLabel(%q) = true, want false (real name/number)", s)
		}
	}
}

// TestSelfLabel proves the self chat/actor never renders as our own number or a
// masked value (contract §R7.3): a real push name wins, everything else -> "You".
func TestSelfLabel(t *testing.T) {
	tests := []struct{ push, want string }{
		{"Aditya", "Aditya"},
		{"", "You"},
		{"+919731006976", "You"}, // a number push name is not a name
		{"+91••••••15", "You"},   // a masked push name is not a name
	}
	for _, tt := range tests {
		if got := selfLabel(tt.push); got != tt.want {
			t.Errorf("selfLabel(%q) = %q, want %q", tt.push, got, tt.want)
		}
	}
}

// TestClassifyPollAndHighlyStructured proves poll questions (previously dropped)
// and top-level HighlyStructuredMessage business templates ingest as text
// (contract §R6.2, bug 1: missing messages).
func TestClassifyPollAndHighlyStructured(t *testing.T) {
	poll := &waE2E.Message{PollCreationMessage: &waE2E.PollCreationMessage{
		Name: strp("Dinner Friday?"),
	}}
	if kind, text, _ := classify(poll); kind != protocol.KindPoll || text != "📊 Dinner Friday?" {
		t.Fatalf("classify(poll) = (%q, %q), want (poll, %q)", kind, text, "📊 Dinner Friday?")
	}

	hsm := &waE2E.Message{HighlyStructuredMessage: &waE2E.HighlyStructuredMessage{
		LocalizableParams: []*waE2E.HighlyStructuredMessage_HSMLocalizableParameter{
			{Default: strp("Your OTP is 1234")},
		},
	}}
	if kind, text, _ := classify(hsm); kind != protocol.KindMessage || text != "Your OTP is 1234" {
		t.Fatalf("classify(highlyStructured) = (%q, %q), want (message, %q)", kind, text, "Your OTP is 1234")
	}
}
