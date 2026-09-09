# ChatGPT OAuth Phase 0b Operator Runbook

Status: development acceptance only. These commands are not application runtime setup.

## Fixed authorization

- Owner: Aditya Katare
- Account fingerprint: `7d41db9e5a28`
- Model: `gpt-5.6-sol`
- Authorized cumulative inference attempts: `55`
- Already consumed: `5`
- Active account-specific planned inference POSTs: `45`
- Inference retries: `0`
- Current application version: `13.12.2`

The original live catalogue evidence resolved matrix v1 to 46 inference POSTs and 9 unsupported skips. Matrix v2 omitted unsupported `max_output_tokens` and resolved to 45 POSTs with 10 skips. Attempts 4 and 5 then exposed probe-only request differences: a reused deterministic session ID, a 12.8 KiB cache prompt instead of the production canary, and strict rejection before parsing an absent-Content-Type response. Append-only revision 3 now uses fresh independent request/session IDs, the exact production `Reply with OK.` canary, shared `Accept: application/json` wire construction, exact trimmed `OK` acceptance, and bounded strict SSE parsing for exact non-redirected absent-Content-Type responses. The cumulative grant is 5/55 with no reusable checkpoint. Do not use full-contract mode until a later explicitly authorized matrix-v3 canary succeeds and the ledger contains that exact checkpoint.

## 1. Obtain the selected-model plan fingerprint

Run only while the owner is ready to approve the browser page. The command binds the fixed localhost callback before opening the system browser and completes automatically after approval; the owner never copies or enters a code. Create a fresh empty owner-only scratch directory under the macOS temporary directory, then run:

```sh
probe_scratch="$(mktemp -d "${TMPDIR%/}/supertwin-chatgpt-plan.XXXXXX")"
chmod 700 "$probe_scratch"

SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE=1 \
SUPERTWIN_RUN_LIVE_CHATGPT_DISCOVERY_PROBE=1 \
SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT=7d41db9e5a28 \
SUPERTWIN_CHATGPT_PROBE_MODEL=gpt-5.6-sol \
SUPERTWIN_APP_VERSION=13.12.2 \
SUPERTWIN_HOME="$probe_scratch" \
npm run probe:chatgpt-oauth -- --live-auth --live-discover --emit-authorization-plan
```

Acceptance:

- The safe JSON output contains `planFingerprint` for exactly `gpt-5.6-sol`.
- HTTP actuals contain one model request, one quota request, zero inference and zero other requests.
- Account fingerprint is exactly `7d41db9e5a28`; quota is healthy; logout succeeds.
- `SUPERTWIN_HOME` remains the same empty directory. Remove it only after manually confirming that it is the exact temporary path created above.

Stop on any account mismatch, token-exchange or metadata 401/403, any 429, CAPTCHA, warning, restriction, unhealthy quota, missing model, malformed response, or nonzero inference/other count. There is one browser navigation and one automatic authorization-code exchange; device-code and device-poll counts must both remain zero.

## 2. Historical create-once ledger initialization

Create a persistent external directory. It must be owned by the current user, mode `0700`, and outside `SUPERTWIN_HOME`:

```sh
ledger_dir="$HOME/.supertwinv13-phase0b-authorization"
mkdir -m 700 "$ledger_dir"
```

`mkdir` must create a new directory. If the path already exists in any form, stop; do not reuse it, follow it, change its permissions, or remove it. Before continuing, verify it is a real directory owned by the current user with mode `0700`.

The accepted discovery produced matrix version `phase0b-contract-matrix-v1`, hash `b02baf6834d23ad8fbaf5df4f693f3f924ce6f8787cc9173f1668995e96cac88`, and 46 planned inference POSTs. Run the sole-argument offline initializer:

```sh
SUPERTWIN_HOME="$probe_scratch" \
SUPERTWIN_CHATGPT_AUTHORIZATION_LEDGER_PATH="$ledger_dir/inference-authorization.sqlite" \
SUPERTWIN_CHATGPT_AUTHORIZATION_ID=phase0b-2026-09-08-gpt-5.6-sol-55 \
SUPERTWIN_CHATGPT_AUTHORIZATION_OWNER="Aditya Katare" \
SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT=7d41db9e5a28 \
SUPERTWIN_CHATGPT_PROBE_MODEL=gpt-5.6-sol \
SUPERTWIN_CHATGPT_AUTHORIZATION_MATRIX_VERSION=phase0b-contract-matrix-v1 \
SUPERTWIN_CHATGPT_AUTHORIZATION_MATRIX_HASH=b02baf6834d23ad8fbaf5df4f693f3f924ce6f8787cc9173f1668995e96cac88 \
SUPERTWIN_CHATGPT_AUTHORIZED_INFERENCE_POSTS=55 \
SUPERTWIN_CHATGPT_AUTHORIZED_PLANNED_INFERENCE_POSTS=46 \
SUPERTWIN_CHATGPT_AUTHORIZATION_INITIAL_CONSUMED_POSTS=2 \
npm run probe:chatgpt-oauth -- --initialize-authorization-ledger
```

Acceptance: output reports `plannedInferencePosts: 46`, `authorizedPosts: 55`, `consumedPosts: 2`, `remainingPosts: 53`, `networkCalls: 0`, and `createOnce: true`. The command refuses if the ledger already exists; never delete, replace, or edit it to reset the counter.

This step has already completed. Do not rerun it or create a replacement ledger. The existing ledger subsequently charged attempt 3, leaving the cumulative state at 3/55.

## 3. Historical append-only successors

The successor changes only the transport request matrix. It preserves the existing grant, root plan, attempt 3 and cumulative 3/55 state. Run this sole-argument command only against that existing ledger:

```sh
SUPERTWIN_HOME="$probe_scratch" \
SUPERTWIN_CHATGPT_AUTHORIZATION_LEDGER_PATH="$ledger_dir/inference-authorization.sqlite" \
SUPERTWIN_CHATGPT_AUTHORIZATION_ID=phase0b-2026-09-08-gpt-5.6-sol-55 \
SUPERTWIN_CHATGPT_AUTHORIZATION_OWNER="Aditya Katare" \
SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT=7d41db9e5a28 \
SUPERTWIN_CHATGPT_PROBE_MODEL=gpt-5.6-sol \
SUPERTWIN_CHATGPT_AUTHORIZED_INFERENCE_POSTS=55 \
SUPERTWIN_CHATGPT_AUTHORIZATION_PREDECESSOR_REVISION=1 \
SUPERTWIN_CHATGPT_AUTHORIZATION_PREDECESSOR_MATRIX_VERSION=phase0b-contract-matrix-v1 \
SUPERTWIN_CHATGPT_AUTHORIZATION_PREDECESSOR_MATRIX_HASH=b02baf6834d23ad8fbaf5df4f693f3f924ce6f8787cc9173f1668995e96cac88 \
SUPERTWIN_CHATGPT_AUTHORIZATION_PREDECESSOR_PLANNED_INFERENCE_POSTS=46 \
SUPERTWIN_CHATGPT_AUTHORIZATION_EXPECTED_CONSUMED_POSTS=3 \
SUPERTWIN_CHATGPT_AUTHORIZATION_SUCCESSOR_TRANSITION_ID=transport-only-request-matrix-v2 \
SUPERTWIN_CHATGPT_AUTHORIZATION_SUCCESSOR_MATRIX_VERSION=phase0b-contract-matrix-v2 \
SUPERTWIN_CHATGPT_AUTHORIZATION_SUCCESSOR_MATRIX_HASH=a6c50fd7c7725b65525d35db1e9ad4d3060619be5e7e405ead68cf19d2555b09 \
SUPERTWIN_CHATGPT_AUTHORIZATION_SUCCESSOR_PLANNED_INFERENCE_POSTS=45 \
npm run probe:chatgpt-oauth -- --append-authorization-plan-successor
```

Completed 2026-09-09: output reported revision `2`, transition `transport-only-request-matrix-v2`, 45 planned POSTs, 55 authorized, 3 consumed, 52 remaining, `networkCalls: 0`, and `appendOnly: true`. The command refuses replay or any predecessor, counter, grant or successor mismatch. Never rerun it or edit the database.

After attempt 5, the reviewed matrix-v3 successor was also appended offline. It activated revision `3`, transition `request-matrix-v3-production-canary`, matrix hash `5bcf8cfc86f44bcb16e26b78522d096deaf1527cef32f2b3b37503dbbed2dfd9`, and 45 planned POSTs while preserving 5/55 consumed and 50 remaining. It reported `networkCalls: 0` and created no inference reservation or checkpoint. Both successor operations are complete; never rerun either one.

## 4. Completed matrix-v3 canary and authorized-resume boundary

The historical matrix-v2 canaries consumed attempts 4 and 5 and failed closed on identical HTTP-200, absent-Content-Type, 5,884-byte responses. Attempt 5 used the automatic browser callback and no manual code entry. Matrix-v3 attempt 6 then passed with the production-equivalent canary: exactly one `gpt-5.6-sol` inference POST, zero retries, exact trimmed `OK`, and the automatic browser callback. Its durable sequence-1 checkpoint leaves the ledger at 6/55. The exact matrix-v3 resume requires 44 additional inference POSTs and would leave 5; it remains forbidden until the owner grants that separate live authorization.

The completed canary command was:

```sh
canary_scratch="$(mktemp -d "${TMPDIR%/}/supertwin-chatgpt-canary.XXXXXX")"
chmod 700 "$canary_scratch"

SUPERTWIN_RUN_LIVE_CHATGPT_OAUTH_PROBE=1 \
SUPERTWIN_RUN_LIVE_CHATGPT_CANARY_PROBE=1 \
SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT=7d41db9e5a28 \
SUPERTWIN_CHATGPT_PROBE_MODEL=gpt-5.6-sol \
SUPERTWIN_APP_VERSION=13.12.2 \
SUPERTWIN_HOME="$canary_scratch" \
SUPERTWIN_CHATGPT_AUTHORIZATION_LEDGER_PATH="$ledger_dir/inference-authorization.sqlite" \
SUPERTWIN_CHATGPT_AUTHORIZATION_ID=phase0b-2026-09-08-gpt-5.6-sol-55 \
SUPERTWIN_CHATGPT_AUTHORIZATION_OWNER="Aditya Katare" \
SUPERTWIN_CHATGPT_AUTHORIZED_INFERENCE_POSTS=55 \
SUPERTWIN_CHATGPT_AUTHORIZATION_MATRIX_VERSION=phase0b-contract-matrix-v3 \
SUPERTWIN_CHATGPT_AUTHORIZATION_MATRIX_HASH=5bcf8cfc86f44bcb16e26b78522d096deaf1527cef32f2b3b37503dbbed2dfd9 \
SUPERTWIN_CHATGPT_AUTHORIZED_PLANNED_INFERENCE_POSTS=45 \
SUPERTWIN_CHATGPT_AUTHORIZATION_PLAN_REVISION=3 \
SUPERTWIN_CHATGPT_AUTHORIZATION_PLAN_TRANSITION_ID=request-matrix-v3-production-canary \
npm run probe:chatgpt-oauth -- --live-auth --live-canary
```

The command used browser Authorization Code + PKCE with the automatic `http://localhost:1455/auth/callback` return. It never displayed or accepted a device code. Actual worker fetches were token POSTs `2`, models GET `1`, quota GETs `2`, inference POST `1`, with device-code/device-poll/other `0` and zero retries, plus one browser navigation.

The separately authorized matrix-v3 resume used the same immutable binding and stopped correctly at sequence 21 after seven inference POSTs. Exact actuals were token POSTs `2`, models GET `1`, quota GETs `1`, inference POSTs `7`, total worker fetches `11`, plus one automatic browser navigation and localhost callback; device-code/device-poll/other and retries were `0`. The ledger is now 13/55. The HTTP 400 safely identified `previous_response_id`: the prior response was deliberately `store:false`, so the backend could not resume it. No later matrix case ran.

Matrix-v4 preserves reservation posts 6–13 as the exact sequence map `1,2,3,5,7,13,17,21`, records sequence 21 as `backend-incompatible`, and converts sequences 1–21 into immutable non-posting prefix evidence. Its SHA-256 is `5d0620739e82a1c8ea4bc610ed2afd91247c67554b4552a6d26a145172ccaa6b`. Revision 4 was appended offline with `networkCalls: 0`, preserving 13/55. The separately authorized suffix then completed all 37 untouched posts with zero retries. Exact worker actuals were token `2`, models `1`, quota `2`, inference `37`, device-code/device-poll/other `0`, total `42`, plus one automatic browser navigation and localhost callback. All posted cases matched, the 1/4/8/16 concurrency ladder completed without failures or rate limits, start/end quota remained healthy at 41% with zero delta, credentials were logged out, and the scratch home was empty and removed. The durable ledger is 50/55 with five calls intentionally unused. Never rerun the successor or suffix.

## Forbidden operations

- Do not append matrix-v4 or rerun its completed revision-4/hash-bound 37-request suffix.
- Do not use a different account, model, app version, matrix fingerprint, owner, authorization ID, or cap.
- Do not reuse a nonempty scratch home or the production SuperTwin home.
- Do not edit SQLite manually, copy in a lower counter, delete the ledger, or initialize a replacement grant.
- Do not persist OAuth tokens, account IDs, response IDs, prompts, outputs, or raw backend bodies.
