# SuperTwinV13 ChatGPT Codex Implementation

## Summary

Add two selectable ways to use a user's ChatGPT subscription:

1. **ChatGPT OAuth mode** for casual users.
2. **Codex CLI mode** for developers.

Claude remains the default until the user changes it.

## 1. ChatGPT OAuth Mode

1. Add a `chatgpt-oauth` provider backed by Codex App Server.
2. Add a simple Settings flow: **Sign in with ChatGPT**, **Use device code**, **Check account**, and **Sign out**.
3. Start the official ChatGPT browser or device-code login flow through App Server. Show progress and the logged-in plan in SuperTwin.
4. Let App Server store and refresh the OAuth tokens. SuperTwin must never read, save, log, or send the tokens itself.
5. Use App Server's structured events for streamed answers, conversation continuity, cancellation, usage limits, and login errors.

## 2. Codex CLI Mode

1. Add a `codex-local` provider beside `claude-local`.
2. Run `codex exec` with JSON output. Convert its output into SuperTwin's existing provider events.
3. Support model choice, session continuation, cancellation, timeouts, and clear errors for a missing CLI, sign-in failure, quota limit, or invalid output.
4. Reuse SuperTwin's existing budget, trace, stop-all, and concurrency safeguards.
5. Respect the user's existing Codex configuration and login. Do not overwrite `CODEX_HOME`, Codex settings, or credentials.

## 3. Provider Choice and Settings

1. Register all three providers: existing Claude, ChatGPT OAuth, and Codex CLI.
2. Add a persisted provider choice and provider-specific model list in Settings.
3. Show the required setup only for the selected provider:
   - **ChatGPT OAuth:** sign in from SuperTwin.
   - **Codex CLI:** install Codex and sign in using the user's normal Codex workflow.
4. Keep provider and model changes behind the existing golden-evaluation gate.

## 4. Safety and Tests

1. Store only provider name, model, session reference, and non-sensitive status. Never store access tokens, refresh tokens, `auth.json`, API keys, or account email addresses.
2. Add fake-runtime tests for OAuth status, login success/failure, device code, token refresh request, streamed events, cancellation, session reuse, and provider switching.
3. Keep normal tests at zero live model calls. Add separate, opt-in smoke tests: one OAuth/App Server call and one Codex CLI call.
4. Verify that logging, SQLite, traces, and surfaced errors contain no credentials.

## Assumptions

1. Both modes run locally on the user's Mac in the first release.
2. ChatGPT OAuth mode uses Codex App Server's managed ChatGPT login, not a custom OAuth client and not an undocumented ChatGPT API.
3. Codex CLI mode is a separate execution path for users who want the standard terminal workflow.
4. API-key authentication, remote workers, and shared credential homes are out of scope for this release.

## References

- OpenAI: [Codex App Server](https://learn.chatgpt.com/es-419/docs/app-server)
- OpenAI: [Authentication](https://learn.chatgpt.com/es-419/docs/auth)
- Paperclip: [Codex local adapter](https://github.com/paperclipai/paperclip/blob/master/docs/adapters/codex-local.md)
