package wa

import (
	"testing"

	"go.mau.fi/whatsmeow/types"
)

// mustJID parses a JID or fails the test.
func mustJID(t *testing.T, s string) types.JID {
	t.Helper()
	j, err := types.ParseJID(s)
	if err != nil {
		t.Fatalf("ParseJID(%q): %v", s, err)
	}
	return j
}

// TestCanonicalJID is the table-driven proof that canonicalization collapses
// device-suffix / LID / self variants of one identity to a single stable key
// (contract §R2.4, bug 7).
func TestCanonicalJID(t *testing.T) {
	selfPN := mustJID(t, "15550000001@s.whatsapp.net")
	selfLID := mustJID(t, "99990000001@lid")

	// LID store: 22221111@lid <-> 15551234567 (Mom); no mapping for 33334444@lid.
	lidToPN := map[string]types.JID{
		"22221111": mustJID(t, "15551234567@s.whatsapp.net"),
	}
	c := &canonicalizer{
		selfPN:  selfPN,
		selfLID: selfLID,
		resolveLIDToPN: func(lid types.JID) (types.JID, bool) {
			pn, ok := lidToPN[lid.User]
			return pn, ok
		},
	}

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"bare PN unchanged", "15551234567@s.whatsapp.net", "15551234567@s.whatsapp.net"},
		{"PN with device suffix stripped", "15551234567:12@s.whatsapp.net", "15551234567@s.whatsapp.net"},
		{"PN with agent+device stripped", "15551234567.2:5@s.whatsapp.net", "15551234567@s.whatsapp.net"},
		{"LID resolves to PN", "22221111@lid", "15551234567@s.whatsapp.net"},
		{"LID with device resolves to PN", "22221111:3@lid", "15551234567@s.whatsapp.net"},
		{"unmapped LID kept (stable, non-AD)", "33334444@lid", "33334444@lid"},
		{"unmapped LID device stripped", "33334444:7@lid", "33334444@lid"},
		{"group JID unchanged", "120363000000000001@g.us", "120363000000000001@g.us"},
		{"group JID device stripped", "120363000000000001:0@g.us", "120363000000000001@g.us"},
		{"self PN -> self PN", "15550000001@s.whatsapp.net", "15550000001@s.whatsapp.net"},
		{"self PN with device -> self PN", "15550000001:9@s.whatsapp.net", "15550000001@s.whatsapp.net"},
		{"self LID -> self PN", "99990000001@lid", "15550000001@s.whatsapp.net"},
		{"self LID with device -> self PN", "99990000001:4@lid", "15550000001@s.whatsapp.net"},
		{"empty stays empty", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var in types.JID
			if tt.in != "" {
				in = mustJID(t, tt.in)
			}
			got := c.canonicalString(in)
			if got != tt.want {
				t.Fatalf("canonicalString(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestCanonicalCollapsesDuplicate proves the concrete bug-7 scenario: the SAME
// person addressed as a LID (live) and a PN (history) yields ONE key, and the
// device-suffixed variant folds in too.
func TestCanonicalCollapsesDuplicate(t *testing.T) {
	c := &canonicalizer{
		selfPN: mustJID(t, "15550000001@s.whatsapp.net"),
		resolveLIDToPN: func(lid types.JID) (types.JID, bool) {
			if lid.User == "88887777" {
				return mustJID(t, "15559876543@s.whatsapp.net"), true
			}
			return types.EmptyJID, false
		},
	}
	variants := []string{
		"15559876543@s.whatsapp.net",    // history (PN)
		"15559876543:21@s.whatsapp.net", // live with device suffix
		"88887777@lid",                  // live LID-addressed
		"88887777:6@lid",                // LID with device
	}
	want := "15559876543@s.whatsapp.net"
	for _, v := range variants {
		if got := c.canonicalString(mustJID(t, v)); got != want {
			t.Fatalf("variant %q canonicalized to %q, want single key %q", v, got, want)
		}
	}
}

// TestSelfChatSingleChannel proves the self chat is one stable canonical
// channel regardless of PN/LID/device addressing (contract §R2.4, bug 2).
func TestSelfChatSingleChannel(t *testing.T) {
	c := &canonicalizer{
		selfPN:  mustJID(t, "15550000001@s.whatsapp.net"),
		selfLID: mustJID(t, "99990000001@lid"),
	}
	selfVariants := []string{
		"15550000001@s.whatsapp.net",
		"15550000001:12@s.whatsapp.net",
		"99990000001@lid",
		"99990000001:3@lid",
	}
	want := "15550000001@s.whatsapp.net"
	for _, v := range selfVariants {
		if got := c.canonicalString(mustJID(t, v)); got != want {
			t.Fatalf("self variant %q canonicalized to %q, want %q", v, got, want)
		}
	}
}

// TestNameIsBetter locks the late-name-upgrade policy (bug 4): a real name beats
// a number, a number never downgrades a real name, and no-op cases don't churn.
func TestNameIsBetter(t *testing.T) {
	tests := []struct {
		name    string
		newName string
		prev    string
		want    bool
	}{
		{"number -> real name upgrades", "Hrishikesh", "+15551234567", true},
		{"bare digits -> real name upgrades", "Mom", "15551234567", true},
		{"real name -> number never downgrades", "+15551234567", "Hrishikesh", false},
		{"same real name no churn", "Mom", "Mom", false},
		{"empty never emits", "", "Mom", false},
		{"number -> number no churn", "+15551234567", "15551234567", false},
		{"real -> different real re-emits", "Mom Smith", "Mom", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := nameIsBetter(tt.newName, tt.prev); got != tt.want {
				t.Fatalf("nameIsBetter(%q, %q) = %v, want %v", tt.newName, tt.prev, got, tt.want)
			}
		})
	}
}

// TestHandleFromJID ensures PN JIDs get a + phone handle and LID JIDs do NOT get
// mislabeled as a phone number.
func TestHandleFromJID(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"15551234567@s.whatsapp.net", "+15551234567"},
		{"15551234567:8@s.whatsapp.net", "+15551234567"},
		{"22221111@lid", "22221111"},
		{"120363000000000001@g.us", "120363000000000001"},
	}
	for _, tt := range tests {
		if got := handleFromJID(mustJID(t, tt.in)); got != tt.want {
			t.Fatalf("handleFromJID(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// TestFallbackLabel checks last-resort labels used when no real name is known.
func TestFallbackLabel(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"15551234567@s.whatsapp.net", "+15551234567"},
		{"120363000000000001@g.us", "120363000000000001"},
		{"33334444@lid", "33334444"},
	}
	for _, tt := range tests {
		if got := fallbackLabel(mustJID(t, tt.in)); got != tt.want {
			t.Fatalf("fallbackLabel(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
