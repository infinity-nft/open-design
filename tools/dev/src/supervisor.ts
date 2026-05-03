/**
 * Foreground supervisor for `pnpm tools-dev run`.
 *
 * After both sidecar apps are up, polls their IPC status every 3 s. When an
 * app that was previously healthy stops responding (crash or stuck), the
 * supervisor:
 *
 *   1. Waits an exponential-backoff delay (1 s → 2 s → 4 s → … capped at
 *      30 s).
 *   2. Calls the provided `onRestart` callback (stop → start).
 *   3. Gives up after 5 consecutive crashes within a 2-minute window and
 *      prints an actionable hint.
 *
 * Only daemon and web are supervised. Desktop has its own lifecycle and is
 * deliberately excluded.
 *
 * The supervisor runs as a background async loop that exits when the supplied
 * AbortSignal fires (on SIGINT / SIGTERM).
 */

import { APP_KEYS } from "@open-design/sidecar-proto";

import type { ToolDevAppName } from "./config.js";
import { inspectDaemonRuntime, inspectWebRuntime, type AppRuntimeLookup } from "./sidecar-client.js";

const POLL_MS = 3_000;
const INITIAL_GRACE_MS = 6_000;
const MAX_ATTEMPTS = 5;
const RESET_WINDOW_MS = 120_000;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function isAppLive(appName: ToolDevAppName, lookup: AppRuntimeLookup): Promise<boolean> {
  if (appName === APP_KEYS.DAEMON) {
    const snap = await inspectDaemonRuntime(lookup, 1500);
    return snap != null && snap.url != null;
  }
  if (appName === APP_KEYS.WEB) {
    const snap = await inspectWebRuntime(lookup, 1500);
    return snap != null && snap.url != null;
  }
  return true;
}

export interface SupervisorParams {
  appName: ToolDevAppName;
  lookup: AppRuntimeLookup;
  signal: AbortSignal;
  onRestart: (appName: ToolDevAppName) => Promise<void>;
}

export async function runSupervisor({ appName, lookup, signal, onRestart }: SupervisorParams): Promise<void> {
  if (appName === APP_KEYS.DESKTOP) return;

  let seenLive = false;
  let attempts = 0;
  let lastCrashAt = 0;

  // Grace period: let the process reach ready state before supervising.
  try {
    await sleepOrAbort(INITIAL_GRACE_MS, signal);
  } catch {
    return;
  }

  while (!signal.aborted) {
    let live: boolean;
    try {
      live = await isAppLive(appName, lookup);
    } catch {
      live = false;
    }

    if (live) {
      seenLive = true;
      attempts = 0;
    } else if (seenLive) {
      // Was healthy — now unreachable: treat as crash.
      const now = Date.now();
      if (now - lastCrashAt > RESET_WINDOW_MS) attempts = 0;
      lastCrashAt = now;
      attempts++;

      if (attempts > MAX_ATTEMPTS) {
        process.stderr.write(
          `\n[supervisor] ${appName} crashed ${attempts} times within ${RESET_WINDOW_MS / 1000}s` +
          ` — giving up. Run \`tools-dev restart ${appName}\` to recover.\n`,
        );
        return;
      }

      const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
      process.stderr.write(
        `\n[supervisor] ${appName} is not responding` +
        ` — restarting in ${(delay / 1000).toFixed(0)}s` +
        ` (attempt ${attempts}/${MAX_ATTEMPTS})\n`,
      );

      try {
        await sleepOrAbort(delay, signal);
      } catch {
        return;
      }

      try {
        await onRestart(appName);
        process.stderr.write(`[supervisor] ${appName} restarted\n`);
        // Reset seenLive so we wait for it to become live again before
        // counting the next crash as another attempt.
        seenLive = false;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[supervisor] ${appName} restart failed: ${msg}\n`);
      }
    }

    try {
      await sleepOrAbort(POLL_MS, signal);
    } catch {
      return;
    }
  }
}
