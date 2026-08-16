// ===========================================================================
// [CODE] Phase-5 flag-gated registration for the calendar source (build item
// 5.1; build doc §7 rule 2: "Do not register a second adapter before Phase 5").
//
// The default boot registers EXACTLY ONE adapter (whatsapp, worker/src/
// index.ts). This module is the second source's only door in, and it is shut
// unless the Phase-5 flag is explicitly set: without SUPERTWIN_PHASE5_CALENDAR=1
// `maybeRegisterCalendarSource()` is a no-op returning null, so nothing about
// the shipped single-source boot changes by this file existing.
//
// Registration itself is the GENERIC path — registerSource() with the same
// validation, the same probes, the same one-id-one-source refusal WhatsApp
// goes through. That is the thesis: the second source is a manifest + an
// adapter behind a flag, and zero lines of core code know it exists.
// ===========================================================================

import {
  getSource,
  registerSource,
  type RegisteredSource,
} from "../registry.js";
import type { SourceEvent } from "../types.js";
import { CalendarAdapter, type CalendarAdapterOptions } from "./adapter.js";
import { CALENDAR_MANIFEST, CALENDAR_SOURCE_ID } from "./manifest.js";

/** The Phase-5 flag. Anything but exactly "1" leaves the calendar source off. */
export const CALENDAR_PHASE5_ENV = "SUPERTWIN_PHASE5_CALENDAR";

/** True when the Phase-5 calendar source is switched on. */
export function calendarPhase5Enabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[CALENDAR_PHASE5_ENV] === "1";
}

/**
 * Register the calendar source IFF the Phase-5 flag is set. Returns the
 * registered pair, or null when the flag is off (the default) or the source is
 * already registered (idempotent — boot paths and tests may both ask).
 *
 * Throws ManifestError only for a genuinely invalid manifest, which is the
 * same boot-error contract every source lives under (§2.2).
 */
export function maybeRegisterCalendarSource(
  opts: CalendarAdapterOptions = {},
  env: Record<string, string | undefined> = process.env,
): RegisteredSource<SourceEvent> | null {
  if (!calendarPhase5Enabled(env)) return null;
  if (getSource(CALENDAR_SOURCE_ID)) return null;
  return registerSource<SourceEvent>({
    manifest: CALENDAR_MANIFEST,
    adapter: new CalendarAdapter(opts),
  });
}
