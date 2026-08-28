// ===========================================================================
// SuperTwin Browser core — build P3.4, spec §12. Public surface.
// ===========================================================================

export { CdpClient, CdpError, type RawCdpTransport, type CdpEvent } from "./cdp.js";
export {
  browserProfileDir,
  chromiumPath,
  launchChromium,
  type LaunchedChromium,
} from "./chromium.js";
export { AgentTabRegistry, TabIsolationError, type AgentTab } from "./tabs.js";
export {
  BROWSER_KILL_SWITCH_KEY,
  BROWSER_PAUSED_SOURCES_KEY,
  BrowserHardStopError,
  LoginAutomationError,
  SafetyController,
  classifyPage,
  type BrowserNotice,
  type PageClass,
  type PageSample,
} from "./safety.js";
export {
  ACTIVE_HOUR_END,
  ACTIVE_HOUR_START,
  JITTER_MS,
  MAX_ACTION_DELAY_MS,
  MIN_ACTION_DELAY_MS,
  Pacer,
  SKIP_PROBABILITY,
  siteOf,
  type ScheduledRun,
} from "./pacing.js";
export {
  BrowserHarness,
  SourcePausedError,
  type CapturedRequest,
  type RunLogEntry,
  type Snapshot,
  type SnapshotNode,
} from "./harness.js";
export { registerBrowserTools } from "./tools.js";
export {
  AccountConnector,
  IMPORT_FROM_CHROME_URL,
  SERVICES,
  serviceById,
  type ConnectableService,
  type SessionHealth,
} from "./sessions.js";
export { BrowserManager, browserManager, handleBrowserRoute } from "./routes.js";
