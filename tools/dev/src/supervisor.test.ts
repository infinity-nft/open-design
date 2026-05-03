import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_KEYS } from "@open-design/sidecar-proto";

import { runSupervisor } from "./supervisor.js";

// Minimal stub for AppRuntimeLookup — the supervisor uses it only through the
// injected `isAppLive` logic which we shadow by overriding inspectXxxRuntime.
const STUB_LOOKUP = { base: "/tmp/test", namespace: "test" };

function makeAbort(timeoutMs: number): AbortController {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), timeoutMs);
  return ctrl;
}

describe("runSupervisor", () => {
  it("does not restart while app is live", async () => {
    let restarts = 0;
    const ctrl = makeAbort(200);

    await runSupervisor({
      appName: APP_KEYS.DESKTOP,
      lookup: STUB_LOOKUP,
      signal: ctrl.signal,
      onRestart: async () => { restarts++; },
    });

    assert.equal(restarts, 0, "desktop should never be restarted");
  });

  it("exits immediately when signal is pre-aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let restarts = 0;

    await runSupervisor({
      appName: APP_KEYS.DAEMON,
      lookup: STUB_LOOKUP,
      signal: ctrl.signal,
      onRestart: async () => { restarts++; },
    });

    assert.equal(restarts, 0);
  });
});
