package rangefilter

import (
	"testing"
	"time"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

var now = time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)

func TestRangeCutoff(t *testing.T) {
	tests := []struct {
		r    protocol.Range
		want time.Time
	}{
		{protocol.Range24h, now.Add(-24 * time.Hour)},
		{protocol.Range3d, now.Add(-3 * 24 * time.Hour)},
		{protocol.Range7d, now.Add(-7 * 24 * time.Hour)},
		{protocol.Range30d, now.Add(-30 * 24 * time.Hour)},
		{protocol.Range90d, now.Add(-90 * 24 * time.Hour)},
		{protocol.Range180d, now.Add(-180 * 24 * time.Hour)},
		{protocol.Range1y, now.Add(-365 * 24 * time.Hour)},
		{protocol.Range2y, now.Add(-2 * 365 * 24 * time.Hour)},
		{protocol.Range3y, now.Add(-3 * 365 * 24 * time.Hour)},
		{protocol.Range4y, now.Add(-4 * 365 * 24 * time.Hour)},
		{protocol.Range5y, now.Add(-5 * 365 * 24 * time.Hour)},
		{protocol.RangeAll, time.Unix(0, 0).UTC()},
	}
	for _, tt := range tests {
		got := RangeCutoff(tt.r, now)
		if !got.Equal(tt.want) {
			t.Errorf("RangeCutoff(%q) = %v, want %v", tt.r, got, tt.want)
		}
	}
}

func TestRangeCutoffUnknownFallsBackToAll(t *testing.T) {
	got := RangeCutoff(protocol.Range("bogus"), now)
	want := time.Unix(0, 0).UTC()
	if !got.Equal(want) {
		t.Errorf("unknown range cutoff = %v, want epoch %v", got, want)
	}
}

func TestAllRangesCovered(t *testing.T) {
	// Every value listed in AllRanges must produce a well-defined cutoff.
	if len(AllRanges()) != 12 {
		t.Fatalf("expected 12 ranges, got %d", len(AllRanges()))
	}
	for _, r := range AllRanges() {
		c := RangeCutoff(r, now)
		if r == protocol.RangeAll {
			if !c.Equal(time.Unix(0, 0).UTC()) {
				t.Errorf("all cutoff not epoch: %v", c)
			}
			continue
		}
		if !c.Before(now) {
			t.Errorf("cutoff for %q (%v) not before now", r, c)
		}
	}
}

func TestChatInRange(t *testing.T) {
	tests := []struct {
		name     string
		r        protocol.Range
		activity time.Time
		want     bool
	}{
		{"7d: active 3d ago -> in", protocol.Range7d, now.Add(-3 * 24 * time.Hour), true},
		{"7d: active 10d ago -> out", protocol.Range7d, now.Add(-10 * 24 * time.Hour), false},
		{"7d: exactly at cutoff -> in (>=)", protocol.Range7d, now.Add(-7 * 24 * time.Hour), true},
		{"24h: active 2h ago -> in", protocol.Range24h, now.Add(-2 * time.Hour), true},
		{"24h: active 25h ago -> out", protocol.Range24h, now.Add(-25 * time.Hour), false},
		{"all: 200d ago -> in", protocol.RangeAll, now.Add(-200 * 24 * time.Hour), true},
		{"all: epoch -> in", protocol.RangeAll, time.Unix(0, 0).UTC(), true},
	}
	for _, tt := range tests {
		if got := ChatInRange(tt.r, tt.activity, now); got != tt.want {
			t.Errorf("%s: ChatInRange = %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestMessageInRange(t *testing.T) {
	tests := []struct {
		name string
		r    protocol.Range
		ts   time.Time
		want bool
	}{
		{"30d: 20d ago -> in", protocol.Range30d, now.Add(-20 * 24 * time.Hour), true},
		{"30d: 40d ago -> out", protocol.Range30d, now.Add(-40 * 24 * time.Hour), false},
		{"30d: exactly at cutoff -> in", protocol.Range30d, now.Add(-30 * 24 * time.Hour), true},
		{"all: 5y ago -> in", protocol.RangeAll, now.Add(-5 * 365 * 24 * time.Hour), true},
		{"1y: 300d ago -> in", protocol.Range1y, now.Add(-300 * 24 * time.Hour), true},
		{"1y: 400d ago -> out", protocol.Range1y, now.Add(-400 * 24 * time.Hour), false},
		{"2y: 400d ago -> in", protocol.Range2y, now.Add(-400 * 24 * time.Hour), true},
		{"2y: 800d ago -> out", protocol.Range2y, now.Add(-800 * 24 * time.Hour), false},
		{"3y: 800d ago -> in", protocol.Range3y, now.Add(-800 * 24 * time.Hour), true},
		{"3y: 1200d ago -> out", protocol.Range3y, now.Add(-1200 * 24 * time.Hour), false},
		{"4y: 1200d ago -> in", protocol.Range4y, now.Add(-1200 * 24 * time.Hour), true},
		{"4y: 1500d ago -> out", protocol.Range4y, now.Add(-1500 * 24 * time.Hour), false},
		{"5y: 1500d ago -> in", protocol.Range5y, now.Add(-1500 * 24 * time.Hour), true},
		{"5y: 1900d ago -> out", protocol.Range5y, now.Add(-1900 * 24 * time.Hour), false},
		{"5y: exactly at cutoff -> in", protocol.Range5y, now.Add(-5 * 365 * 24 * time.Hour), true},
	}
	for _, tt := range tests {
		if got := MessageInRange(tt.r, tt.ts, now); got != tt.want {
			t.Errorf("%s: MessageInRange = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// TestRangeMonotonic verifies that wider ranges never exclude what narrower
// ranges include (extend-widen invariant, contract §4).
func TestRangeMonotonic(t *testing.T) {
	ordered := []protocol.Range{
		protocol.Range24h, protocol.Range3d, protocol.Range7d, protocol.Range30d,
		protocol.Range90d, protocol.Range180d, protocol.Range1y,
		protocol.Range2y, protocol.Range3y, protocol.Range4y, protocol.Range5y,
		protocol.RangeAll,
	}
	ts := now.Add(-100 * 24 * time.Hour) // 100 days ago
	sawIncluded := false
	for _, r := range ordered {
		in := MessageInRange(r, ts, now)
		if in {
			sawIncluded = true
		} else if sawIncluded {
			t.Errorf("range %q excluded a message that a narrower range included (non-monotonic)", r)
		}
	}
	if !MessageInRange(protocol.RangeAll, ts, now) {
		t.Error("all must include a 100d-old message")
	}
}

// TestCountByRangeMatchesImportFilters (S1.5 / CNS-09 "events exact"): the
// per-window counts are exactly what an import of that window would emit — the
// chat-activity filter and the message filter applied in that order.
func TestCountByRangeMatchesImportFilters(t *testing.T) {
	h := time.Hour
	stamps := []Stamp{
		// Active chat: newest 2h ago, three messages spread over 40 days.
		{Chat: "a@g.us", TS: now.Add(-2 * h)},
		{Chat: "a@g.us", TS: now.Add(-5 * 24 * h)},
		{Chat: "a@g.us", TS: now.Add(-40 * 24 * h)},
		// Stale chat: newest 10 days ago — outside 24h/3d/7d ENTIRELY, even its
		// messages that would be "in range" by ts alone are excluded.
		{Chat: "b@s.whatsapp.net", TS: now.Add(-10 * 24 * h)},
		{Chat: "b@s.whatsapp.net", TS: now.Add(-12 * 24 * h)},
		// Ancient chat: 3 years back.
		{Chat: "c@s.whatsapp.net", TS: now.Add(-3 * 365 * 24 * h)},
	}
	got := CountByRange(stamps, now)

	want := map[protocol.Range]protocol.RangeCount{
		protocol.Range24h:  {Chats: 1, Messages: 1},
		protocol.Range3d:   {Chats: 1, Messages: 1},
		protocol.Range7d:   {Chats: 1, Messages: 2},
		protocol.Range30d:  {Chats: 2, Messages: 4},
		protocol.Range90d:  {Chats: 2, Messages: 5},
		protocol.Range180d: {Chats: 2, Messages: 5},
		protocol.Range1y:   {Chats: 2, Messages: 5},
		protocol.Range2y:   {Chats: 2, Messages: 5},
		protocol.Range3y:   {Chats: 3, Messages: 6}, // ts == cutoff is IN range (>=), like MessageInRange
		protocol.Range4y:   {Chats: 3, Messages: 6},
		protocol.Range5y:   {Chats: 3, Messages: 6},
		protocol.RangeAll:  {Chats: 3, Messages: 6},
	}
	for _, r := range AllRanges() {
		if got[r] != want[r] {
			t.Errorf("CountByRange[%s] = %+v, want %+v", r, got[r], want[r])
		}
	}
	// Cross-check against the filters an import actually runs, message by message.
	for _, r := range AllRanges() {
		last := map[string]time.Time{}
		for _, s := range stamps {
			if s.TS.After(last[s.Chat]) {
				last[s.Chat] = s.TS
			}
		}
		n := 0
		for _, s := range stamps {
			if ChatInRange(r, last[s.Chat], now) && MessageInRange(r, s.TS, now) {
				n++
			}
		}
		if n != got[r].Messages {
			t.Errorf("range %s: filter walk counts %d, CountByRange %d", r, n, got[r].Messages)
		}
	}
	oldest, newest := Bounds(stamps)
	if !oldest.Equal(now.Add(-3*365*24*h)) || !newest.Equal(now.Add(-2*h)) {
		t.Errorf("Bounds = %v / %v", oldest, newest)
	}
}

func TestCountByRangeEmpty(t *testing.T) {
	got := CountByRange(nil, now)
	for _, r := range AllRanges() {
		if got[r] != (protocol.RangeCount{}) {
			t.Errorf("empty CountByRange[%s] = %+v, want zero", r, got[r])
		}
	}
	if o, n := Bounds(nil); !o.IsZero() || !n.IsZero() {
		t.Errorf("Bounds(nil) = %v/%v, want zero", o, n)
	}
}
