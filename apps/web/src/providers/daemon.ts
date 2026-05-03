/**
 * Daemon provider — fetch-based SSE client for /api/runs. The daemon can
 * emit three event streams depending on the agent's streamFormat:
 *   - 'agent'   : typed events emitted by Claude Code's stream-json parser
 *                 (status, text_delta, thinking_delta, tool_use, tool_result,
 *                 usage, raw). We forward these to the UI as AgentEvent items.
 *   - 'stdout'  : plain chunks from other CLIs. We wrap them in a single
 *                 rolling 'text' event.
 *   - 'stderr'  : incidental stderr. Shown only when the process exits
 *                 non-zero (tail appended to the error message).
 */
import type { AgentEvent, ChatCommentAttachment, ChatMessage } from '../types';
import type {
  ChatRunCreateResponse,
  ChatRunListResponse,
  ChatRunStatus,
  ChatRunStatusResponse,
  ChatRequest,
  ChatSseEvent,
  ChatSseStartPayload,
  DaemonAgentPayload,
  SseErrorPayload,
} from '@open-design/contracts';
import type { StreamHandlers } from './anthropic';
import { parseSseFrame } from './sse';

export interface DaemonStreamHandlers extends StreamHandlers {
  onAgentEvent: (ev: AgentEvent) => void;
}

export interface DaemonStreamOptions {
  agentId: string;
  history: ChatMessage[];
  /** Legacy field accepted by older tests/callers. Daemon-owned prompt composition ignores it. */
  systemPrompt?: string;
  /** Stops the current browser-side SSE subscription. The daemon run continues. */
  signal: AbortSignal;
  /** Explicit user cancellation signal. This maps to POST /api/runs/:id/cancel. */
  cancelSignal?: AbortSignal;
  handlers: DaemonStreamHandlers;
  // The active project's id. When supplied, the daemon spawns the agent
  // with cwd = the project folder so its file tools target the right
  // workspace.
  projectId?: string | null;
  conversationId?: string | null;
  assistantMessageId?: string | null;
  clientRequestId?: string | null;
  skillId?: string | null;
  designSystemId?: string | null;
  // Project-relative paths the user has staged for this turn. The
  // daemon resolves them inside the project folder, validates they
  // exist, and stitches them into the user message as `@<path>` hints.
  attachments?: string[];
  commentAttachments?: ChatCommentAttachment[];
  // Per-CLI model + reasoning the user picked in the model menu. Both are
  // optional; the daemon validates them against the agent's declared
  // options and falls back to the CLI default when missing.
  model?: string | null;
  reasoning?: string | null;
  initialLastEventId?: string | null;
  onRunCreated?: (runId: string) => void;
  onRunStatus?: (status: ChatRunStatus) => void;
  onRunEventId?: (eventId: string) => void;
}

export interface DaemonReattachOptions {
  runId: string;
  signal: AbortSignal;
  cancelSignal?: AbortSignal;
  handlers: DaemonStreamHandlers;
  initialLastEventId?: string | null;
  onRunStatus?: (status: ChatRunStatus) => void;
  onRunEventId?: (eventId: string) => void;
}

export async function streamViaDaemon({
  agentId,
  history,
  signal,
  cancelSignal,
  handlers,
  projectId,
  conversationId,
  assistantMessageId,
  clientRequestId,
  skillId,
  designSystemId,
  attachments,
  commentAttachments,
  model,
  reasoning,
  initialLastEventId,
  onRunCreated,
  onRunStatus,
  onRunEventId,
}: DaemonStreamOptions): Promise<void> {
  // Local CLIs are single-turn print-mode programs, so we collapse the whole
  // chat into one string. If this becomes too noisy for long histories, the
  // fix is to only include the final user turn.
  const transcript = history
    .map((m) => `## ${m.role}\n${m.content.trim()}`)
    .join('\n\n');
  const request: ChatRequest = {
    agentId,
    message: transcript,
    projectId: projectId ?? null,
    conversationId: conversationId ?? null,
    assistantMessageId: assistantMessageId ?? null,
    clientRequestId: clientRequestId ?? null,
    skillId: skillId ?? null,
    designSystemId: designSystemId ?? null,
    attachments: attachments ?? [],
    commentAttachments: commentAttachments ?? [],
    model: model ?? null,
    reasoning: reasoning ?? null,
  };
  const body = JSON.stringify(request);

  try {
    const createResp = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!createResp.ok) {
      const text = await createResp.text().catch(() => '');
      onRunStatus?.('failed');
      handlers.onError(new Error(`daemon ${createResp.status}: ${text || 'no body'}`));
      return;
    }

    const created = (await createResp.json()) as ChatRunCreateResponse;
    const runId = created.runId;
    onRunCreated?.(runId);
    onRunStatus?.('queued');
    await consumeDaemonRun({
      runId,
      signal,
      cancelSignal,
      handlers,
      initialLastEventId,
      onRunStatus,
      onRunEventId,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    onRunStatus?.('failed');
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

export async function reattachDaemonRun(options: DaemonReattachOptions): Promise<void> {
  await consumeDaemonRun(options);
}

export async function fetchChatRunStatus(runId: string): Promise<ChatRunStatusResponse | null> {
  try {
    const resp = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as ChatRunStatusResponse;
  } catch {
    return null;
  }
}

export async function listActiveChatRuns(
  projectId: string,
  conversationId: string,
): Promise<ChatRunStatusResponse[]> {
  try {
    const qs = new URLSearchParams({ projectId, conversationId, status: 'active' });
    const resp = await fetch(`/api/runs?${qs.toString()}`);
    if (!resp.ok) return [];
    const body = (await resp.json()) as ChatRunListResponse;
    return body.runs ?? [];
  } catch {
    return [];
  }
}

async function consumeDaemonRun({
  runId,
  signal,
  cancelSignal,
  handlers,
  initialLastEventId,
  onRunStatus,
  onRunEventId,
}: DaemonReattachOptions): Promise<void> {
  let acc = '';
  let stderrBuf = '';
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let endStatus: ChatRunStatus | null = null;
  let lastEventId: string | null = initialLastEventId ?? null;
  let canceled = false;
  const cancelRun = () => {
    if (canceled) return;
    canceled = true;
    void fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }).catch(() => {});
  };

  cancelSignal?.addEventListener('abort', cancelRun, { once: true });
  try {
    if (cancelSignal?.aborted) {
      cancelRun();
      return;
    }

    // Exponential backoff between reconnect attempts. Without this we
    // would burn through the 5-attempt budget in milliseconds when the
    // daemon is genuinely down. Sequence: 0ms (first try), 250ms,
    // 500ms, 1000ms, 2000ms. Cap at 5 retries; the loop body resets
    // the counter to 0 whenever a stream made progress (events or
    // keepalive), so transient network blips during a long generation
    // do not exhaust the budget.
    const BACKOFF_MS = [0, 250, 500, 1000, 2000];
    for (let reconnects = 0; endStatus === null && reconnects < BACKOFF_MS.length;) {
      const delay = BACKOFF_MS[reconnects] ?? 2000;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      }
      const qs = lastEventId ? `?after=${encodeURIComponent(lastEventId)}` : '';
      let resp: Response;
      try {
        resp = await fetch(`/api/runs/${encodeURIComponent(runId)}/events${qs}`, {
          method: 'GET',
          signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        reconnects += 1;
        continue;
      }

      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        handlers.onError(new Error(`daemon ${resp.status}: ${text || 'no body'}`));
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let sawStreamProgress = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.kind === 'comment') {
            sawStreamProgress = true;
            continue;
          }
          if (parsed.kind !== 'event') continue;
          sawStreamProgress = true;
          if (parsed.id) {
            lastEventId = parsed.id;
            onRunEventId?.(parsed.id);
          }

          const event = parsed as unknown as ChatSseEvent;

          if (event.event === 'stdout') {
            const chunk = String(event.data.chunk ?? '');
            acc += chunk;
            handlers.onDelta(chunk);
            handlers.onAgentEvent({ kind: 'text', text: chunk });
            continue;
          }

          if (event.event === 'stderr') {
            stderrBuf += event.data.chunk ?? '';
            continue;
          }

          if (event.event === 'agent') {
            const translated = translateAgentEvent(event.data);
            if (!translated) continue;
            if (translated.kind === 'text') {
              acc += translated.text;
              handlers.onDelta(translated.text);
            }
            handlers.onAgentEvent(translated);
            continue;
          }

          if (event.event === 'start') {
            const data = event.data as ChatSseStartPayload;
            onRunStatus?.('running');
            handlers.onAgentEvent({
              kind: 'status',
              label: 'starting',
              detail: typeof data.bin === 'string' ? data.bin : undefined,
            });
            continue;
          }

          if (event.event === 'error') {
            onRunStatus?.('failed');
            const data = event.data as SseErrorPayload;
            handlers.onError(new Error(String(data.error?.message ?? data.message ?? 'daemon error')));
            return;
          }

          if (event.event === 'replay-gap') {
            // The daemon's ring buffer trimmed events the client had
            // not yet seen. Surface as a status update so the chat
            // shell can warn the user that the previous artifact's
            // streamed text may be incomplete. Run continues — the
            // gap only affects events strictly between requestedAfter
            // and firstAvailable, not the live stream after this
            // point.
            const data = event.data as { droppedCount?: number };
            const dropped = typeof data.droppedCount === 'number' ? data.droppedCount : 0;
            handlers.onAgentEvent({
              kind: 'status',
              label: 'replay-gap',
              detail: `${dropped} event${dropped === 1 ? '' : 's'} were lost during reconnect; the chat above may be incomplete`,
            });
            continue;
          }

          if (event.event === 'lint-result') {
            // Forward the daemon's post-run lint findings as a typed
            // agent event. The chat shell can render a P0/P1 badge per
            // artifact and offer an "Auto-revise" affordance that
            // re-prompts with `agentMessage`. Empty findings arrive
            // only when at least one artifact had a finding, so it is
            // safe to render the chip unconditionally here.
            const data = event.data;
            handlers.onAgentEvent({
              kind: 'lint',
              artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
              hasP0: Boolean(data.hasP0),
              hasP1: Boolean(data.hasP1),
              totals: data.totals ?? { p0: 0, p1: 0, p2: 0 },
              agentMessage: typeof data.agentMessage === 'string' ? data.agentMessage : '',
            });
            continue;
          }

          if (event.event === 'critique-result') {
            // Visual self-critique emitted by the agent (when
            // OD_VISUAL_CRITIQUE is on). Sibling to lint-result; the
            // chat shell renders findings in a similar card.
            const data = event.data;
            handlers.onAgentEvent({
              kind: 'critique',
              verdict: data.verdict === 'revise' ? 'revise' : 'ship',
              reasoning: typeof data.reasoning === 'string' ? data.reasoning : '',
              findings: Array.isArray(data.findings) ? data.findings : [],
              totals: data.totals ?? { p0: 0, p1: 0, p2: 0 },
            });
            continue;
          }

          if (event.event === 'judge-result') {
            // Multi-shot judge verdict (when OD_MULTI_SHOT is on). Pairs
            // with K artifacts the agent emitted in the same turn; chat
            // shell renders a JudgeCard with winner + ranking.
            const data = event.data;
            handlers.onAgentEvent({
              kind: 'judge',
              winner: typeof data.winner === 'string' ? data.winner : '',
              axis: typeof data.axis === 'string' ? data.axis : '',
              ranking: Array.isArray(data.ranking) ? data.ranking : [],
              rationale: Array.isArray(data.rationale) ? data.rationale : [],
              confidence:
                data.confidence === 'high' || data.confidence === 'low'
                  ? data.confidence
                  : 'medium',
            });
            continue;
          }

          if (event.event === 'end') {
            exitCode = typeof event.data.code === 'number' ? event.data.code : null;
            exitSignal = typeof event.data.signal === 'string' ? event.data.signal : null;
            endStatus = isChatRunStatus(event.data.status) ? event.data.status : 'succeeded';
            onRunStatus?.(endStatus);
          }
        }
      }
      reconnects = sawStreamProgress ? 0 : reconnects + 1;
    }

    if (endStatus === null) {
      const status = await fetchChatRunStatus(runId);
      if (status && isChatRunStatus(status.status) && status.status !== 'queued' && status.status !== 'running') {
        endStatus = status.status;
        exitCode = status.exitCode ?? null;
        exitSignal = status.signal ?? null;
        onRunStatus?.(endStatus);
      } else {
        handlers.onError(new Error('daemon stream disconnected before run completed'));
        return;
      }
    }

    if (endStatus === 'canceled') return;

    if (endStatus === 'failed' || exitSignal || (exitCode !== null && exitCode !== 0)) {
      const tail = stderrBuf.trim().slice(-400);
      handlers.onError(
        new Error(`agent exited with ${exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`}${tail ? `\n${tail}` : ''}`),
      );
      return;
    }
    handlers.onDone(acc);
  } finally {
    cancelSignal?.removeEventListener('abort', cancelRun);
  }
}

function isChatRunStatus(value: unknown): value is ChatRunStatus {
  return value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'canceled';
}

// Translate a raw `agent` SSE payload (what apps/daemon/src/claude-stream.ts emits)
// into the UI's AgentEvent union. Keep this liberal — unknown types just
// return null so the UI ignores them instead of rendering garbage.
function translateAgentEvent(data: DaemonAgentPayload): AgentEvent | null {
  const t = data.type;
  if (t === 'status' && typeof data.label === 'string') {
    return {
      kind: 'status',
      label: data.label,
      detail:
        typeof data.model === 'string'
          ? data.model
          : typeof data.ttftMs === 'number'
            ? `first token in ${Math.round((data.ttftMs as number) / 100) / 10}s`
            : undefined,
    };
  }
  if (t === 'text_delta' && typeof data.delta === 'string') {
    return { kind: 'text', text: data.delta };
  }
  if (t === 'thinking_delta' && typeof data.delta === 'string') {
    return { kind: 'thinking', text: data.delta };
  }
  if (t === 'thinking_start') {
    return { kind: 'status', label: 'thinking' };
  }
  if (t === 'tool_use' && typeof data.id === 'string' && typeof data.name === 'string') {
    return { kind: 'tool_use', id: data.id, name: data.name, input: data.input ?? null };
  }
  if (t === 'tool_result' && typeof data.toolUseId === 'string') {
    return {
      kind: 'tool_result',
      toolUseId: data.toolUseId,
      content: String(data.content ?? ''),
      isError: Boolean(data.isError),
    };
  }
  if (t === 'usage') {
    const usage = (data.usage ?? {}) as Record<string, number>;
    return {
      kind: 'usage',
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costUsd: typeof data.costUsd === 'number' ? data.costUsd : undefined,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
    };
  }
  if (t === 'raw' && typeof data.line === 'string') {
    return { kind: 'raw', line: data.line };
  }
  return null;
}

export async function saveArtifact(
  identifier: string,
  title: string,
  html: string,
): Promise<{ url: string; path: string } | null> {
  try {
    const resp = await fetch('/api/artifacts/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, title, html }),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as { url: string; path: string };
  } catch {
    return null;
  }
}
