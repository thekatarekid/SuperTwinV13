// Package rangefilter implements the pure range/backfill semantics from
// docs/PHASE1_CONTRACT.md §4. These functions are the single source of truth
// for the daemon and must match the TS worker's implementation exactly.
package rangefilter

import (
	"time"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// durations maps each Range to its lookback window. "all" is handled
// separately (no cutoff / epoch 0).
var durations = map[protocol.Range]time.Duration{
	protocol.Range24h:  24 * time.Hour,
	protocol.Range3d:   3 * 24 * time.Hour,
	protocol.Range7d:   7 * 24 * time.Hour,
	protocol.Range30d:  30 * 24 * time.Hour,
	protocol.Range90d:  90 * 24 * time.Hour,
	protocol.Range180d: 180 * 24 * time.Hour,
	protocol.Range1y:   365 * 24 * time.Hour,
	protocol.Range2y:   2 * 365 * 24 * time.Hour,
	protocol.Range3y:   3 * 365 * 24 * time.Hour,
	protocol.Range4y:   4 * 365 * 24 * time.Hour,
	protocol.Range5y:   5 * 365 * 24 * time.Hour,
}

// RangeCutoff returns the cutoff time for range r relative to now.
// For "all" (and any unknown range) it returns the Unix epoch (time 0),
// meaning "no cutoff — include everything".
func RangeCutoff(r protocol.Range, now time.Time) time.Time {
	if r == protocol.RangeAll {
		return time.Unix(0, 0).UTC()
	}
	d, ok := durations[r]
	if !ok {
		// Unknown ranges fall back to "all" semantics (include everything)
		// so the daemon never silently drops data on a protocol mismatch.
		return time.Unix(0, 0).UTC()
	}
	return now.Add(-d)
}

// ChatInRange reports whether a chat whose most recent activity is
// lastActivity should be included for range r (contract §4, filter 1:
// active within the range). A chat is in range iff lastActivity >= cutoff.
func ChatInRange(r protocol.Range, lastActivity, now time.Time) bool {
	cutoff := RangeCutoff(r, now)
	return !lastActivity.Before(cutoff)
}

// MessageInRange reports whether a message with timestamp ts should be
// included for range r (contract §4, filter 2: ts >= cutoff).
func MessageInRange(r protocol.Range, ts, now time.Time) bool {
	cutoff := RangeCutoff(r, now)
	return !ts.Before(cutoff)
}

// AllRanges lists every valid range value, for tests and validation.
func AllRanges() []protocol.Range {
	return []protocol.Range{
		protocol.Range24h, protocol.Range3d, protocol.Range7d, protocol.Range30d,
		protocol.Range90d, protocol.Range180d, protocol.Range1y,
		protocol.Range2y, protocol.Range3y, protocol.Range4y, protocol.Range5y,
		protocol.RangeAll,
	}
}

// Stamp is the minimum a message contributes to a window count: the chat it
// belongs to and when it was sent. The count_range flow (V6 P1 S1.5, T4-7)
// records one per history message as batches arrive, so a per-window count can
// be MEASURED over what WhatsApp actually sent instead of estimated.
type Stamp struct {
	Chat string
	TS   time.Time
}

// CountByRange applies the two contract §4 filters to every stamp for every
// range — exactly the way an import of that range would — and returns what each
// window would deliver. Filter 1: a chat is in range iff its most recent stamp
// is at or after the cutoff. Filter 2: a message is in range iff its own ts is
// at or after the cutoff. A chat that survives filter 1 with no messages past
// filter 2 cannot happen (its newest message IS at or after the cutoff), so
// Chats counts chats with at least one in-range message.
func CountByRange(stamps []Stamp, now time.Time) map[protocol.Range]protocol.RangeCount {
	last := make(map[string]time.Time, 64)
	for _, s := range stamps {
		if cur, ok := last[s.Chat]; !ok || s.TS.After(cur) {
			last[s.Chat] = s.TS
		}
	}
	out := make(map[protocol.Range]protocol.RangeCount, len(AllRanges()))
	for _, r := range AllRanges() {
		cutoff := RangeCutoff(r, now)
		chats := 0
		for _, lastTS := range last {
			if !lastTS.Before(cutoff) {
				chats++
			}
		}
		msgs := 0
		for _, s := range stamps {
			if last[s.Chat].Before(cutoff) {
				continue
			}
			if !s.TS.Before(cutoff) {
				msgs++
			}
		}
		out[r] = protocol.RangeCount{Chats: chats, Messages: msgs}
	}
	return out
}

// Bounds returns the oldest and newest stamp timestamps (zero when empty).
func Bounds(stamps []Stamp) (oldest, newest time.Time) {
	for _, s := range stamps {
		if oldest.IsZero() || s.TS.Before(oldest) {
			oldest = s.TS
		}
		if newest.IsZero() || s.TS.After(newest) {
			newest = s.TS
		}
	}
	return oldest, newest
}
