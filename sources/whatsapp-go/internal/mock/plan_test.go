package mock

import (
	"testing"
	"time"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// fixed reference time so "ago" offsets map deterministically.
var testNow = time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)

func TestBuiltinFixtureShape(t *testing.T) {
	f := BuiltinFixture()
	// Raw fixture declares the two Hrishikesh addressings (PN + LID) separately;
	// they collapse to one channel after canonicalization (verified below). The
	// raw fixture also carries noise "group"-kind chats (status/newsletter) that
	// are filtered out of the plan (bug 17), so count REAL groups by excluding
	// noise JIDs rather than raw fixture kind.
	var group int
	for _, c := range f.Chats {
		if c.Kind == "group" && !skipMockChatJID(c.JID) {
			group++
		}
	}
	if group != 1 {
		t.Errorf("expected exactly 1 real group, got %d", group)
	}
	// self chat is a dm to self; ensure a self actor exists.
	if f.selfActorJID() == "" {
		t.Error("fixture has no self actor")
	}

	// At least one media event exists.
	hasMedia := false
	for _, m := range f.Messages {
		if m.Media != nil {
			hasMedia = true
		}
	}
	if !hasMedia {
		t.Error("fixture must include at least one media event")
	}
}

// TestBuildPlanCanonicalCollapsesDuplicateChat proves the mock pipeline collapses
// the LID-vs-PN duplicate (bug 7): the "all" plan yields ONE "Hrishikesh"
// channel keyed by the canonical PN, carrying both messages.
func TestBuildPlanCanonicalCollapsesDuplicateChat(t *testing.T) {
	f := BuiltinFixture()
	p := f.BuildPlan(protocol.RangeAll, testNow)

	const hrishPN = "15557654321@s.whatsapp.net"
	hrishChannels := 0
	for _, c := range p.Channels {
		if c.Name == "Hrishikesh" {
			hrishChannels++
			if c.SourceExtID != hrishPN {
				t.Errorf("Hrishikesh channel key = %q, want canonical PN %q", c.SourceExtID, hrishPN)
			}
		}
		// No emitted channel may be LID-addressed after canonicalization.
		if len(c.SourceExtID) > 4 && c.SourceExtID[len(c.SourceExtID)-4:] == "@lid" {
			t.Errorf("channel emitted with un-canonicalized LID key: %q", c.SourceExtID)
		}
	}
	if hrishChannels != 1 {
		t.Fatalf("expected 1 Hrishikesh channel after canonicalization, got %d", hrishChannels)
	}

	// Both the LID-addressed and PN-addressed messages land in that one chat.
	got := map[string]string{}
	for _, e := range p.Events {
		if e.Msg.MessageID == "HRI_LIVE_1" || e.Msg.MessageID == "HRI_HIST_1" {
			got[e.Msg.MessageID] = e.Msg.ChatJID
		}
	}
	if got["HRI_LIVE_1"] != hrishPN || got["HRI_HIST_1"] != hrishPN {
		t.Fatalf("Hrishikesh messages not unified under %q: %v", hrishPN, got)
	}
}

// TestBuildPlanSelfChatCollapses proves the device-suffixed live self message
// and the bare self-chat share ONE canonical self channel (bug 2 / self chat).
func TestBuildPlanSelfChatCollapses(t *testing.T) {
	f := BuiltinFixture()
	p := f.BuildPlan(protocol.RangeAll, testNow)

	const selfPN = "15550000001@s.whatsapp.net"
	selfChannels := 0
	for _, c := range p.Channels {
		if c.SourceExtID == selfPN {
			selfChannels++
		}
	}
	if selfChannels != 1 {
		t.Fatalf("expected exactly 1 self channel keyed %q, got %d", selfPN, selfChannels)
	}
	// The device-suffixed live self message must be keyed to the canonical self PN.
	found := false
	for _, e := range p.Events {
		if e.Msg.MessageID == "SELF_LIVE_1" {
			found = true
			if e.Msg.ChatJID != selfPN {
				t.Errorf("SELF_LIVE_1 chat = %q, want %q", e.Msg.ChatJID, selfPN)
			}
			if !e.Msg.FromMe {
				t.Error("SELF_LIVE_1 must be from_me")
			}
		}
	}
	if !found {
		t.Error("SELF_LIVE_1 (from_me self message) was dropped — bug 2 regression")
	}
}

func countEvents(p Plan) int { return len(p.Events) }

func TestBuildPlanRangeFiltering(t *testing.T) {
	f := BuiltinFixture()

	all := f.BuildPlan(protocol.RangeAll, testNow)
	sevenD := f.BuildPlan(protocol.Range7d, testNow)
	oneDay := f.BuildPlan(protocol.Range24h, testNow)

	// Wider range must yield >= events than narrower.
	if countEvents(all) <= countEvents(sevenD) {
		t.Errorf("all (%d) should have MORE events than 7d (%d)", countEvents(all), countEvents(sevenD))
	}
	if countEvents(sevenD) < countEvents(oneDay) {
		t.Errorf("7d (%d) should have >= events than 24h (%d)", countEvents(sevenD), countEvents(oneDay))
	}

	// All events in the 7d plan must be within 7 days.
	cutoff := testNow.Add(-7 * 24 * time.Hour)
	for _, e := range sevenD.Events {
		if e.TS.Before(cutoff) {
			t.Errorf("7d plan contains out-of-range event %s @ %v (cutoff %v)", e.Msg.MessageID, e.TS, cutoff)
		}
	}

	// 'all' must include the 200-day-old message.
	found := false
	for _, e := range all.Events {
		if e.Msg.MessageID == "MOM_0004" {
			found = true
		}
	}
	if !found {
		t.Error("all plan should include the 200d-old MOM_0004 message")
	}

	// The 200-day-old message must NOT appear in the 7d plan.
	for _, e := range sevenD.Events {
		if e.Msg.MessageID == "MOM_0004" {
			t.Error("7d plan must not include the 200d-old MOM_0004 message")
		}
	}
}

func TestBuildPlanChatFilter(t *testing.T) {
	// A fixture where a chat's ONLY activity is old: it must be excluded
	// entirely for a narrow range (contract §4 filter 1).
	f := &Fixture{
		Chats: []FixtureChat{
			{JID: "recent@s.whatsapp.net", Name: "Recent", Kind: "dm"},
			{JID: "stale@s.whatsapp.net", Name: "Stale", Kind: "dm"},
		},
		Actors: []FixtureActor{
			{JID: "recent@s.whatsapp.net", DisplayName: "Recent", Handle: "+1"},
			{JID: "stale@s.whatsapp.net", DisplayName: "Stale", Handle: "+2"},
		},
		Messages: []FixtureMessage{
			{ChatJID: "recent@s.whatsapp.net", SenderJID: "recent@s.whatsapp.net", MessageID: "R1", AgoSeconds: 3600, Kind: "message", Text: "hi"},
			{ChatJID: "stale@s.whatsapp.net", SenderJID: "stale@s.whatsapp.net", MessageID: "S1", AgoSeconds: 100 * 24 * 3600, Kind: "message", Text: "old"},
		},
	}
	p := f.BuildPlan(protocol.Range7d, testNow)

	// Only the recent chat/actor/event should survive.
	if len(p.Channels) != 1 || p.Channels[0].SourceExtID != "recent@s.whatsapp.net" {
		t.Errorf("expected only recent channel, got %+v", p.Channels)
	}
	for _, e := range p.Events {
		if e.Msg.ChatJID == "stale@s.whatsapp.net" {
			t.Error("stale chat's message leaked into 7d plan")
		}
	}
}

func TestBuildPlanOnlyEmitsChannelsAndActorsWithEvents(t *testing.T) {
	f := BuiltinFixture()
	p := f.BuildPlan(protocol.Range24h, testNow)

	// Every emitted channel must correspond to at least one event.
	chatWithEvent := map[string]bool{}
	for _, e := range p.Events {
		chatWithEvent[e.Msg.ChatJID] = true
	}
	for _, c := range p.Channels {
		if !chatWithEvent[c.SourceExtID] {
			t.Errorf("channel %s emitted with no in-range event", c.SourceExtID)
		}
	}

	// Every emitted actor must have sent at least one event.
	actorWithEvent := map[string]bool{}
	for _, e := range p.Events {
		actorWithEvent[e.Msg.SenderJID] = true
	}
	for _, a := range p.Actors {
		if !actorWithEvent[a.SourceExtID] {
			t.Errorf("actor %s emitted with no in-range event", a.SourceExtID)
		}
	}
}
