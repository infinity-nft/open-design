// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { createChatRunService } from '../src/runs.js';

// Build a fake SSE response that captures `send`/`end` calls so we can
// assert what the run service streams. No HTTP layer involved — the
// run service only knows about the SSE wrapper interface.
function makeFakeSseFactory() {
  const created: Array<{ sent: Array<{ event: string; data: unknown; id: number | null }>; ended: boolean; cleanedUp: boolean }> = [];
  const factory = (_res: unknown) => {
    const sent: Array<{ event: string; data: unknown; id: number | null }> = [];
    const sse = {
      send(event: string, data: unknown, id: number | null = null) {
        sent.push({ event, data, id });
        return true;
      },
      end() {
        sse._ended = true;
      },
      cleanup() {
        sse._cleanedUp = true;
      },
      _ended: false,
      _cleanedUp: false,
    };
    created.push({
      get sent() { return sent; },
      get ended() { return sse._ended; },
      get cleanedUp() { return sse._cleanedUp; },
    } as never);
    return sse;
  };
  return { factory, created };
}

function makeFakeReq(opts: { lastEventId?: number | null; after?: number | null } = {}) {
  return {
    get(name: string) {
      if (name === 'Last-Event-ID' && opts.lastEventId != null) return String(opts.lastEventId);
      return undefined;
    },
    query: opts.after != null ? { after: String(opts.after) } : {},
  };
}

function makeFakeRes() {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    on(name: string, h: () => void) {
      (handlers[name] ||= []).push(h);
    },
    fire(name: string) {
      for (const h of handlers[name] ?? []) h();
    },
  };
}

const noopErr = (code: string, message: string) => ({ error: { code, message } });

describe('chat run service — emit + replay', () => {
  it('emits events with monotonically increasing ids starting at 1', () => {
    const { factory } = makeFakeSseFactory();
    const svc = createChatRunService({ createSseResponse: factory, createSseErrorPayload: noopErr });
    const run = svc.create();
    const e1 = svc.emit(run, 'agent', { delta: 'a' });
    const e2 = svc.emit(run, 'agent', { delta: 'b' });
    const e3 = svc.emit(run, 'agent', { delta: 'c' });
    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e3.id).toBe(3);
    expect(run.events.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('stream() replays all buffered events when client has not seen any', () => {
    const { factory, created } = makeFakeSseFactory();
    const svc = createChatRunService({ createSseResponse: factory, createSseErrorPayload: noopErr });
    const run = svc.create();
    svc.emit(run, 'agent', { delta: 'a' });
    svc.emit(run, 'agent', { delta: 'b' });

    svc.stream(run, makeFakeReq(), makeFakeRes());
    const sent = created[0]!.sent;
    expect(sent.map((s) => s.id)).toEqual([1, 2]);
    expect(sent[0]!.event).toBe('agent');
  });

  it('stream() with ?after=1 replays only events 2..N', () => {
    const { factory, created } = makeFakeSseFactory();
    const svc = createChatRunService({ createSseResponse: factory, createSseErrorPayload: noopErr });
    const run = svc.create();
    svc.emit(run, 'agent', { delta: 'a' });
    svc.emit(run, 'agent', { delta: 'b' });
    svc.emit(run, 'agent', { delta: 'c' });

    svc.stream(run, makeFakeReq({ after: 1 }), makeFakeRes());
    const sent = created[0]!.sent;
    expect(sent.filter((s) => s.event === 'agent').map((s) => s.id)).toEqual([2, 3]);
  });

  it('respects Last-Event-ID header same as ?after query', () => {
    const { factory, created } = makeFakeSseFactory();
    const svc = createChatRunService({ createSseResponse: factory, createSseErrorPayload: noopErr });
    const run = svc.create();
    svc.emit(run, 'agent', { delta: 'a' });
    svc.emit(run, 'agent', { delta: 'b' });

    svc.stream(run, makeFakeReq({ lastEventId: 1 }), makeFakeRes());
    const sent = created[0]!.sent;
    expect(sent.filter((s) => s.event === 'agent').map((s) => s.id)).toEqual([2]);
  });

  it('emits a replay-gap event when the buffer dropped events the client needs', () => {
    const { factory, created } = makeFakeSseFactory();
    const svc = createChatRunService({
      createSseResponse: factory,
      createSseErrorPayload: noopErr,
      maxEvents: 3,
    });
    const run = svc.create();
    // Emit 5 events with maxEvents=3 → events 1 and 2 are dropped.
    for (const c of ['a', 'b', 'c', 'd', 'e']) svc.emit(run, 'agent', { delta: c });
    expect(run.events.map((r) => r.id)).toEqual([3, 4, 5]);

    // Client says it last saw event 1; it needs 2,3,4,5 — 2 is gone.
    svc.stream(run, makeFakeReq({ after: 1 }), makeFakeRes());
    const sent = created[0]!.sent;
    const gap = sent.find((s) => s.event === 'replay-gap');
    expect(gap).toBeTruthy();
    expect(gap!.data).toMatchObject({
      requestedAfter: 1,
      firstAvailable: 3,
      droppedCount: 1, // event id 2
    });
    // The gap event has no id (it is meta).
    expect(gap!.id).toBeNull();
    // Replay still resumes with what is available.
    expect(sent.filter((s) => s.event === 'agent').map((s) => s.id)).toEqual([3, 4, 5]);
  });

  it('does NOT emit replay-gap when the client is up-to-date or the buffer is contiguous', () => {
    const { factory, created } = makeFakeSseFactory();
    const svc = createChatRunService({
      createSseResponse: factory,
      createSseErrorPayload: noopErr,
      maxEvents: 100,
    });
    const run = svc.create();
    svc.emit(run, 'agent', { delta: 'a' });
    svc.emit(run, 'agent', { delta: 'b' });

    // Client saw event 1 — events 2 is right next; no gap.
    svc.stream(run, makeFakeReq({ after: 1 }), makeFakeRes());
    expect(created[0]!.sent.find((s) => s.event === 'replay-gap')).toBeFalsy();

    // Brand-new client: lastEventId=0 — also no gap.
    svc.stream(run, makeFakeReq(), makeFakeRes());
    expect(created[1]!.sent.find((s) => s.event === 'replay-gap')).toBeFalsy();
  });

  it('closes the SSE response immediately when run is already terminal', () => {
    const { factory, created } = makeFakeSseFactory();
    const svc = createChatRunService({ createSseResponse: factory, createSseErrorPayload: noopErr });
    const run = svc.create();
    svc.emit(run, 'agent', { delta: 'a' });
    svc.finish(run, 'succeeded', 0, null);

    svc.stream(run, makeFakeReq(), makeFakeRes());
    expect(created[0]!.ended).toBe(true);
  });

  it('attaches live clients when run is still running', () => {
    const { factory, created } = makeFakeSseFactory();
    const svc = createChatRunService({ createSseResponse: factory, createSseErrorPayload: noopErr });
    const run = svc.create();
    run.status = 'running';

    svc.stream(run, makeFakeReq(), makeFakeRes());
    expect(run.clients.size).toBe(1);

    // New event reaches the live client.
    svc.emit(run, 'agent', { delta: 'live' });
    expect(created[0]!.sent.some((s) => s.data && (s.data as { delta?: string }).delta === 'live')).toBe(true);
  });

  it('removes client + cleans up on res close', () => {
    const { factory } = makeFakeSseFactory();
    const svc = createChatRunService({ createSseResponse: factory, createSseErrorPayload: noopErr });
    const run = svc.create();
    run.status = 'running';
    const res = makeFakeRes();
    svc.stream(run, makeFakeReq(), res);
    expect(run.clients.size).toBe(1);
    res.fire('close');
    expect(run.clients.size).toBe(0);
  });

  it('finish() emits an end event and disconnects all clients', () => {
    const { factory, created } = makeFakeSseFactory();
    const svc = createChatRunService({ createSseResponse: factory, createSseErrorPayload: noopErr });
    const run = svc.create();
    run.status = 'running';
    svc.stream(run, makeFakeReq(), makeFakeRes());
    expect(run.clients.size).toBe(1);

    svc.finish(run, 'succeeded', 0, null);
    const endEvent = created[0]!.sent.find((s) => s.event === 'end');
    expect(endEvent).toBeTruthy();
    expect(endEvent!.data).toMatchObject({ status: 'succeeded' });
    expect(run.clients.size).toBe(0);
  });

  it('cap on buffer size — old events evicted when maxEvents is exceeded', () => {
    const { factory } = makeFakeSseFactory();
    const svc = createChatRunService({ createSseResponse: factory, createSseErrorPayload: noopErr, maxEvents: 3 });
    const run = svc.create();
    for (let i = 0; i < 10; i++) svc.emit(run, 'agent', { delta: String(i) });
    expect(run.events).toHaveLength(3);
    expect(run.events[0]!.id).toBe(8);
    expect(run.events[2]!.id).toBe(10);
  });
});
