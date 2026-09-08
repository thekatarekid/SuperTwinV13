# ChatGPT OAuth Phase 0b Operator Runbook

Status: development acceptance only. These commands are not application runtime setup.

## Fixed authorization

- Owner: Aditya Katare
- Account fingerprint: `7d41db9e5a28`
- Model: `gpt-5.6-sol`
- Authorized cumulative inference attempts: `55`
- Already consumed: `2`
- Inference retries: `0`
- Current application version: `13.12.2`

Never use the full-contract mode under this grant. Its fresh matrix needs 55 inference POSTs, but only 53 remain. A further successful canary would leave 52; even a future checkpointed 54-POST resume would require a separately approved cumulative cap of at least 57.

## 1. Obtain the selected-model plan fingerprint

Run only while the owner is ready to complete the device-code page. Create a fresh empty owner-only scratch directory under the macOS temporary directory, then run:

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

Stop on any account mismatch, token-exchange or metadata 401/403, any 429, CAPTCHA, warning, restriction, unhealthy quota, missing model, malformed response, or nonzero inference/other count. Bounded device-poll 403/404 responses mean authorization is still pending and are expected.

## 2. Initialize the cumulative ledger offline

Create a persistent external directory. It must be owned by the current user, mode `0700`, and outside `SUPERTWIN_HOME`:

```sh
ledger_dir="$HOME/.supertwinv13-phase0b-authorization"
mkdir -m 700 "$ledger_dir"
```

`mkdir` must create a new directory. If the path already exists in any form, stop; do not reuse it, follow it, change its permissions, or remove it. Before continuing, verify it is a real directory owned by the current user with mode `0700`.

Copy the exact `matrixVersion` and `matrixHash` from step 1, then run the sole-argument offline initializer:

```sh
SUPERTWIN_HOME="$probe_scratch" \
SUPERTWIN_CHATGPT_AUTHORIZATION_LEDGER_PATH="$ledger_dir/inference-authorization.sqlite" \
SUPERTWIN_CHATGPT_AUTHORIZATION_ID=phase0b-2026-09-08-gpt-5.6-sol-55 \
SUPERTWIN_CHATGPT_AUTHORIZATION_OWNER="Aditya Katare" \
SUPERTWIN_CHATGPT_PROBE_ACCOUNT_FINGERPRINT=7d41db9e5a28 \
SUPERTWIN_CHATGPT_PROBE_MODEL=gpt-5.6-sol \
SUPERTWIN_CHATGPT_AUTHORIZATION_MATRIX_VERSION=phase0b-contract-matrix-v1 \
SUPERTWIN_CHATGPT_AUTHORIZATION_MATRIX_HASH="REPLACE_WITH_64_LOWERCASE_HEX_FROM_STEP_1" \
SUPERTWIN_CHATGPT_AUTHORIZED_INFERENCE_POSTS=55 \
SUPERTWIN_CHATGPT_AUTHORIZATION_INITIAL_CONSUMED_POSTS=2 \
npm run probe:chatgpt-oauth -- --initialize-authorization-ledger
```

Acceptance: output reports `authorizedPosts: 55`, `consumedPosts: 2`, `remainingPosts: 53`, `networkCalls: 0`, and `createOnce: true`. The command refuses if the ledger already exists; never delete, replace, or edit it to reset the counter.

## 3. Run one bounded field-diagnostic canary

Only after step 2 passes and the owner is ready at the device page:

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
npm run probe:chatgpt-oauth -- --live-auth --live-canary
```

If execution reaches the inference boundary, the ledger durably reserves attempt 3 before the fetch and never refunds it, including on HTTP 400, cancellation, timeout, SIGINT, or process failure. Cancellation before reservation leaves the counter at 2; cancellation after reservation leaves it at 3. The mode hard-refuses a second inference request. Record only its bounded redacted diagnostic and exact endpoint counts.

## Forbidden operations

- Do not set the full-contract opt-in or pass `--live-contract` under the 55-attempt grant.
- Do not use a different account, model, app version, matrix fingerprint, owner, authorization ID, or cap.
- Do not reuse a nonempty scratch home or the production SuperTwin home.
- Do not edit SQLite manually, copy in a lower counter, delete the ledger, or initialize a replacement grant.
- Do not persist OAuth tokens, account IDs, response IDs, prompts, outputs, or raw backend bodies.
