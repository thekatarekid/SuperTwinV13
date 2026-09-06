// ===========================================================================
// The fixture clock (V6 P1 S3.7).
//
// Every golden case is dated inside Aug–Dec 2026 ("bookings open 10 am
// tomorrow" on 2026-08-29; a flight on 2026-09-02; TIM-03's May message is
// "months ago"). Executors that read the wall clock drift as the calendar
// passes those dates — the S0.1 baseline recorded SCH-01..03 red for exactly
// that reason. Every time-aware executor pins `now` here instead.
//
// Sat 2026-08-29 09:00 IST (03:30Z): after every fixture's message time and
// before every fixture's window.
// ===========================================================================

export const FIXTURE_NOW_ISO = "2026-08-29T03:30:00.000Z";
export const FIXTURE_NOW = new Date(FIXTURE_NOW_ISO);

/** A fresh Date at the fixture instant (callers may mutate their copy). */
export function fixtureNow(): Date {
  return new Date(FIXTURE_NOW.getTime());
}
