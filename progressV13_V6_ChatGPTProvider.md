# SuperTwinV13 V6 ChatGPT Provider Progress

- 2026-09-07: Started V2 implementation audit; required product, build, prompt, eval, and V1/V2 documents are under review.
- 2026-09-07: Confirmed `main` at `fd667ec`, version `13.12.2`; V2/V1 implementation docs are currently untracked user files.
- 2026-09-07: Phase 0a is **blocked on owner decisions** for OAuth client identity, Terms-of-Service risk, and consumer-data retention/consent copy. V2 forbids Phase 0b+ work until all three are accepted and recorded.
- 2026-09-07: Parallel read-only audits started for task graph, code coverage, and macOS DMG/version/test pipeline.
- 2026-09-07: Packaged-app acceptance will use macOS Computer Use; browser tooling is limited to browser-specific connector flows.
- 2026-09-07: Full document/code audit confirms no ChatGPT provider implementation exists yet; current Phase 1 product baseline intentionally ships Claude only.
- 2026-09-07: Corrected V2 execution ambiguities: P2-D parser reference, 21 entries/19 keys, Phase 4b file barrier, and isolated ChatGPT eval-home login.
- 2026-09-07: Safe baseline passed: UI 319/319, build scripts 126/126, worker offline 4,034/4,034 (2 skipped), worker typecheck, and frontend build; test-opened ports closed.
- 2026-09-07: Baseline defect confirmed: the old unfiltered worker command auto-ran three real-Claude suites when the CLI was present; 13 top-level sends/up to 14 CLI attempts failed with zero reported usage (backend billing unknown).
- 2026-09-07: Official-terms review found no public permission for non-Codex use of the private backend; consumer terms prohibit automated/programmatic output extraction. Phase 0a Terms decision remains unresolved.
- 2026-09-07: Added an offline-by-default worker gate and double opt-in live-Claude command; preserved 3 offline server-route checks. Passed worker 4,037/4,037 (7 intentional skips), scripts 138/138 and typecheck with 0 live model calls.
- 2026-09-07: Added deterministic DMG verification for synchronized source/lock versions, manifest hash, mounted self-contained resources, plist, architecture, code signature and Gatekeeper status. Existing 13.12.2 DMG passes local-only verification; ad-hoc signing prevents distribution-ready status.
- 2026-09-07: Hardened release identity: bumps now prevalidate/update `Cargo.lock`, CI checks both lockfiles, and duplicate checks recognize phase-prefixed archives. No build/version bump performed.
- 2026-09-07: Wired mounted DMG verification into release CI before upload; pending rows require the build SHA and completed manifest mismatches remain fatal. Passed 145 script checks and an actual 13.12.2 mounted verification; no new build.
- Next: record the three Phase 0a decisions and accepting owner; then run the serial, explicitly costed Phase 0b live probe.
