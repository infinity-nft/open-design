/**
 * DaemonHealthBadge — surfaces /health/live and /health/ready state in
 * the chat shell so users see when the daemon is down (silent zombie
 * was the worst pre-T1.3 UX).
 *
 * States:
 *   - daemon mode + live=true + ready=true  → render nothing
 *   - daemon mode + live=true + ready=false → amber "Starting…" with reasons
 *   - daemon mode + live=false              → red "Disconnected" with retry
 *   - api mode (Topology C, no daemon)      → render nothing
 *
 * Polls every 5s while mounted; doubles to 10s after two consecutive
 * "ready" results (typical idle path). Resets to 5s on any failure.
 *
 * The component is deliberately small and stateless beyond its own
 * polling. It does not coordinate with run state — a run can be in
 * flight even when the daemon is technically "not ready" if /api/agents
 * later changes; the badge is a passive informational surface.
 */
import { useEffect, useRef, useState } from 'react';
import type { ExecMode } from '../types';
import { daemonReadiness, type DaemonReadiness } from '../providers/registry';

const FAST_INTERVAL_MS = 5000;
const SLOW_INTERVAL_MS = 10_000;
const SLOW_AFTER_GREEN_RUNS = 2;

export function DaemonHealthBadge({ mode }: { mode: ExecMode }) {
  const [state, setState] = useState<DaemonReadiness | null>(null);
  const greenStreak = useRef(0);
  const cancelled = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (mode !== 'daemon') return undefined;
    cancelled.current = false;
    const poll = async () => {
      const result = await daemonReadiness();
      if (cancelled.current) return;
      setState(result);
      if (result.live && result.ready) greenStreak.current += 1;
      else greenStreak.current = 0;
      const next =
        greenStreak.current >= SLOW_AFTER_GREEN_RUNS
          ? SLOW_INTERVAL_MS
          : FAST_INTERVAL_MS;
      timer.current = setTimeout(() => {
        void poll();
      }, next);
    };
    void poll();
    return () => {
      cancelled.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [mode]);

  if (mode !== 'daemon') return null;
  if (!state) return null;
  if (state.live && state.ready) return null;

  const tone = state.live ? 'starting' : 'down';
  const label = state.live ? 'Daemon starting…' : 'Daemon disconnected';

  return (
    <div className={`daemon-health-badge daemon-health-badge--${tone}`} role="status" aria-live="polite">
      <span className="daemon-health-dot" />
      <span className="daemon-health-label">{label}</span>
      {state.reasons.length > 0 ? (
        <span className="daemon-health-reasons" title={state.reasons.join(' · ')}>
          {state.reasons[0]}
          {state.reasons.length > 1 ? ` (+${state.reasons.length - 1})` : ''}
        </span>
      ) : null}
      {!state.live ? (
        <button
          type="button"
          className="daemon-health-retry"
          onClick={() => {
            // The poller already ticks every 5s; this just nudges it
            // immediately by clearing the in-flight timer.
            if (timer.current) {
              clearTimeout(timer.current);
              timer.current = null;
            }
            void daemonReadiness().then((r) => setState(r));
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
