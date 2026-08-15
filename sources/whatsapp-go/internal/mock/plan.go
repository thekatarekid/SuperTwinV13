package mock

import (
	"sort"
	"time"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/rangefilter"
)

// PlannedEvent pairs a fixture message with its resolved timestamp and chat/actor.
type PlannedEvent struct {
	Msg FixtureMessage
	TS  time.Time
}

// Plan is the range-filtered set of channels, actors, and events to emit for a
// backfill/import of a given range. This is the pure, unit-tested core of the
// mock — it applies the two contract §4 filters (chat active within range;
// messages within range) against the fixture using rangefilter.
type Plan struct {
	Channels []protocol.Channel
	Actors   []protocol.Actor
	Events   []PlannedEvent // sorted ascending by timestamp
}

// BuildPlan produces the range-filtered emission plan for the fixture at the
// given range and reference time. Only chats active within the range are
// included, and within those only messages with ts >= cutoff (contract §4).
//
// Every chat/sender JID is CANONICALIZED (device-stripped, LID->PN via LIDMap,
// self-chat collapsed) so LID-vs-PN and device-suffixed variants of the same
// person yield ONE channel/actor — mirroring the real daemon (bug 7). Chat
// activity is bucketed by canonical JID so range filtering is consistent too.
func (f *Fixture) BuildPlan(r protocol.Range, now time.Time) Plan {
	resolved := f.resolve(now)

	// Bucket last-activity by CANONICAL chat JID (variants of one chat share it).
	// Noise chats (status/newsletter/broadcast) and contentless system events are
	// filtered out here so they never influence range decisions or emissions
	// (contract §R4.3, bug 17) — mirroring the real daemon.
	lastActivity := map[string]time.Time{}
	for _, rm := range resolved {
		if skipMockChatJID(rm.msg.ChatJID) || isContentlessSystem(rm.msg) {
			continue
		}
		key := f.canonJID(rm.msg.ChatJID)
		if cur, ok := lastActivity[key]; !ok || rm.ts.After(cur) {
			lastActivity[key] = rm.ts
		}
	}

	// Filter 1: chats active within range (by canonical JID).
	inRangeChats := map[string]bool{}
	for jid, last := range lastActivity {
		if rangefilter.ChatInRange(r, last, now) {
			inRangeChats[jid] = true
		}
	}

	// Filter 2: messages within range, in active chats. Rewrite each event's
	// chat/sender to the canonical JID so downstream ids/keys are canonical.
	var events []PlannedEvent
	usedChats := map[string]bool{}
	usedActors := map[string]bool{}
	for _, rm := range resolved {
		if skipMockChatJID(rm.msg.ChatJID) || isContentlessSystem(rm.msg) {
			continue
		}
		chatCanon := f.canonJID(rm.msg.ChatJID)
		if !inRangeChats[chatCanon] {
			continue
		}
		if !rangefilter.MessageInRange(r, rm.ts, now) {
			continue
		}
		msg := rm.msg
		msg.ChatJID = chatCanon
		msg.SenderJID = f.canonJID(rm.msg.SenderJID)
		events = append(events, PlannedEvent{Msg: msg, TS: rm.ts})
		usedChats[chatCanon] = true
		usedActors[msg.SenderJID] = true
	}

	// Deterministic ordering: events ascending by ts, then message id.
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].TS.Equal(events[j].TS) {
			return events[i].Msg.MessageID < events[j].Msg.MessageID
		}
		return events[i].TS.Before(events[j].TS)
	})

	// Channels: one per canonical id with at least one emitted event, in fixture
	// order, first non-empty name wins (dedupes collapsed variants).
	var channels []protocol.Channel
	emittedChan := map[string]bool{}
	for _, c := range f.Chats {
		key := f.canonJID(c.JID)
		if !usedChats[key] || emittedChan[key] {
			continue
		}
		emittedChan[key] = true
		channels = append(channels, protocol.Channel{
			SourceExtID: key, Name: c.Name, Kind: c.Kind,
		})
	}

	// Actors: one per canonical id that sent an emitted event, in fixture order.
	var actors []protocol.Actor
	emittedAct := map[string]bool{}
	for _, a := range f.Actors {
		key := f.canonJID(a.JID)
		if !usedActors[key] || emittedAct[key] {
			continue
		}
		emittedAct[key] = true
		actors = append(actors, protocol.Actor{
			SourceExtID: key, DisplayName: a.DisplayName, Handle: a.Handle, IsSelf: a.IsSelf,
		})
	}

	return Plan{Channels: channels, Actors: actors, Events: events}
}
