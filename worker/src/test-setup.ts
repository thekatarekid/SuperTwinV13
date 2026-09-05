// ===========================================================================
// vitest setupFiles (worker/vitest.config.ts) — runs before every test file.
//
// The consent gate (db/consent-gate.ts, V6 S1.2) drops any event whose source
// has no live 'connected' consent row. The worker's suites predate consent and
// write events to test things that are not consent, so the gate is OPEN for
// the suite by default. A suite that tests the gate itself (CNS-*) switches it
// back in its own beforeEach:
//
//   const prev = setConsentGateMode("enforce");   // beforeEach
//   setConsentGateMode(prev);                     // afterEach
//
// Production never runs this file; there the gate is enforced unconditionally.
// ===========================================================================

import { setConsentGateMode } from "./db/consent-gate.js";

setConsentGateMode("open");
