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
		protocol.Range90d, protocol.Range180d, protocol.Range1y, protocol.RangeAll,
	}
}
