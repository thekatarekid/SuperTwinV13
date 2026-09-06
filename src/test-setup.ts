// ===========================================================================
// jsdom suite setup (13.12.x · L2).
//
// `useLoad(…, { cacheKey })` keeps each pane's last answer in a module-level
// cache so a sub-tab flip repaints instantly instead of re-asking a busy
// worker. That cache outlives a render, which is the point in the app and a
// trap in a suite: test 2 would open a pane already holding test 1's fixture.
// One reset before every test, for every suite, so each render starts cold.
// ===========================================================================

import { beforeEach } from "vitest";

import { resetLoadCache } from "./components/LoadState";

beforeEach(() => {
  resetLoadCache();
});
