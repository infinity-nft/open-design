// @ts-nocheck
import { randomUUID } from 'node:crypto';

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

export function createChatRunService({
  createSseResponse,
  createSseErrorPayload,
  maxEvents = 2_000,
  ttlMs = 30 * 60 * 1000,
}) {
  const runs = new Map();

  const create = (meta = {}) => {
    const now = Date.now();
    const run = {
      id: randomUUID(),
      projectId: typeof meta.projectId === 'string' && meta.projectId ? meta.projectId : null,
      conversationId: typeof meta.conversationId === 'string' && meta.conversationId ? meta.conversationId : null,
      assistantMessageId: typeof meta.assistantMessageId === 'string' && meta.assistantMessageId ? meta.assistantMessageId : null,
      clientRequestId: typeof meta.clientRequestId === 'string' && meta.clientRequestId ? meta.clientRequestId : null,
      agentId: typeof meta.agentId === 'string' && meta.agentId ? meta.agentId : null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      events: [],
      nextEventId: 1,
      clients: new Set(),
      waiters: new Set(),
      child: null,
      acpSession: null,
      exitCode: null,
      signal: null,
      cancelRequested: false,
    };
    runs.set(run.id, run);
    return run;
  };

  const get = (id) => runs.get(id) ?? null;

  const scheduleCleanup = (run) => {
    setTimeout(() => {
      if (TERMINAL_RUN_STATUSES.has(run.status)) runs.delete(run.id);
    }, ttlMs).unref?.();
  };

  const emit = (run, event, data) => {
    const id = run.nextEventId++;
    const record = { id, event, data };
    run.events.push(record);
    if (run.events.length > maxEvents) run.events.splice(0, run.events.length - maxEvents);
    run.updatedAt = Date.now();
    for (const sse of run.clients) sse.send(event, data, id);
    return record;
  };

  const statusBody = (run) => ({
    id: run.id,
    projectId: run.projectId,
    conversationId: run.conversationId,
    assistantMessageId: run.assistantMessageId,
    agentId: run.agentId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    exitCode: run.exitCode,
    signal: run.signal,
  });

  const finish = (run, status, code = null, signal = null) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return;
    run.status = status;
    run.exitCode = code;
    run.signal = signal;
    run.updatedAt = Date.now();
    emit(run, 'end', { code, signal, status });
    for (const sse of run.clients) sse.end();
    run.clients.clear();
    for (const waiter of run.waiters) waiter(statusBody(run));
    run.waiters.clear();
    scheduleCleanup(run);
  };

  const fail = (run, code, message, init = {}) => {
    emit(run, 'error', createSseErrorPayload(code, message, init));
    finish(run, 'failed', 1, null);
  };

  const start = (run, starter) => {
    void starter(run).catch((err) => {
      fail(run, 'AGENT_EXECUTION_FAILED', err instanceof Error ? err.message : String(err));
    });
    return run;
  };

  const stream = (run, req, res) => {
    const sse = createSseResponse(res);
    const lastEventIdRaw = Number(req.get('Last-Event-ID') || req.query.after || 0);
    const lastEventId = Number.isFinite(lastEventIdRaw) ? lastEventIdRaw : 0;

    // Replay-gap detection. The ring buffer drops oldest events when
    // the run produces more than `maxEvents`. If the client requests
    // `?after=N` and N is older than what we still have buffered, we
    // emit a synthetic `replay-gap` event so the client knows replay
    // is incomplete. Without this the client would silently miss
    // findings, tool-use, or even the `end` event from before the gap.
    if (lastEventId > 0 && run.events.length > 0) {
      const firstId = run.events[0].id;
      if (firstId > lastEventId + 1) {
        sse.send(
          'replay-gap',
          {
            requestedAfter: lastEventId,
            firstAvailable: firstId,
            droppedCount: firstId - (lastEventId + 1),
            runId: run.id,
          },
          // No `id` field — gap notice is meta, not part of the seq
          // and should not be re-sent on a future reconnect.
        );
      }
    }

    for (const record of run.events) {
      if (record.id > lastEventId) {
        sse.send(record.event, record.data, record.id);
      }
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      sse.end();
      return;
    }
    run.clients.add(sse);
    res.on('close', () => {
      run.clients.delete(sse);
      sse.cleanup();
    });
  };

  const list = ({ projectId, conversationId, status } = {}) => Array.from(runs.values()).filter((run) => {
    if (typeof projectId === 'string' && projectId && run.projectId !== projectId) return false;
    if (typeof conversationId === 'string' && conversationId && run.conversationId !== conversationId) return false;
    if (status === 'active') return !TERMINAL_RUN_STATUSES.has(run.status);
    if (typeof status === 'string' && status) return run.status === status;
    return true;
  });

  const cancel = (run) => {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      run.cancelRequested = true;
      run.updatedAt = Date.now();
      if (run.child && !run.child.killed) run.child.kill('SIGTERM');
      else finish(run, 'canceled', null, 'SIGTERM');
    }
  };

  const wait = (run) => {
    if (TERMINAL_RUN_STATUSES.has(run.status)) return Promise.resolve(statusBody(run));
    return new Promise((resolve) => run.waiters.add(resolve));
  };

  return {
    create,
    start,
    get,
    list,
    stream,
    cancel,
    wait,
    emit,
    finish,
    fail,
    statusBody,
    isTerminal(status) {
      return TERMINAL_RUN_STATUSES.has(status);
    },
  };
}
