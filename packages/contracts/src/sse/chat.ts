import type { SseErrorPayload } from '../errors';
import type { SseTransportEvent } from './common';

export const CHAT_SSE_PROTOCOL_VERSION = 1;

export interface ChatSseStartPayload {
  runId?: string;
  agentId?: string;
  bin: string;
  protocolVersion?: typeof CHAT_SSE_PROTOCOL_VERSION;
  /** Legacy daemon-internal absolute cwd. Kept for compatibility during W2 adoption. */
  cwd?: string | null;
  projectId?: string | null;
  model?: string | null;
  reasoning?: string | null;
}

export interface ChatSseChunkPayload {
  chunk: string;
}

export interface ChatSseEndPayload {
  code: number | null;
  signal?: string | null;
  status?: 'succeeded' | 'failed' | 'canceled';
}

export interface LintFindingDto {
  severity: 'P0' | 'P1' | 'P2';
  id: string;
  message: string;
  fix: string;
  snippet?: string;
}

export interface ChatSseLintResultPayload {
  runId: string;
  artifacts: Array<{
    relPath: string;
    findings: LintFindingDto[];
  }>;
  hasP0: boolean;
  hasP1: boolean;
  totals: { p0: number; p1: number; p2: number };
  /**
   * Pre-rendered system-reminder block ready to splice into a
   * follow-up user message when the user (or auto-revise) asks the
   * agent to correct findings. Empty string when there is nothing
   * to feed back.
   */
  agentMessage: string;
}

export interface CritiqueFindingDto {
  severity: 'P0' | 'P1' | 'P2';
  rule: string;
  evidence: string;
  fix: string;
}

/** 5-dimension scores from schema="v2" self-critique. All values 0–10. */
export interface CritiqueScoresDto {
  philosophy: number;
  hierarchy: number;
  detail: number;
  functionality: number;
  innovation: number;
}

export interface ChatSseCritiqueResultPayload {
  runId: string;
  verdict: 'ship' | 'revise';
  reasoning: string;
  findings: CritiqueFindingDto[];
  totals: { p0: number; p1: number; p2: number };
  /** Present when the agent emitted schema="v2" or later. */
  scores?: CritiqueScoresDto;
}

export interface JudgeRationaleDto {
  variant: string;
  verdict: 'win' | 'runner-up' | 'last';
  why: string;
}

/**
 * Synthetic event emitted when a reconnecting client requests events
 * older than what the daemon's ring buffer still has. Tells the client
 * replay is incomplete (some events were trimmed) so it can decide
 * whether to surface a warning or just continue. The event has NO id
 * field — it is meta, not part of the run's sequence, and should not
 * be re-sent on a subsequent reconnect.
 */
export interface ChatSseReplayGapPayload {
  runId: string;
  /** The id the client said it had seen (Last-Event-ID / ?after). */
  requestedAfter: number;
  /** First event id still available in the buffer. */
  firstAvailable: number;
  /** Count of events the client missed and cannot recover. */
  droppedCount: number;
}

export interface ChatSseJudgeResultPayload {
  runId: string;
  /** Variant label, single uppercase letter (e.g. "A"). */
  winner: string;
  /** Which dimension the variants vary on (layout / type / color / density). */
  axis: string;
  /** Ranking from best to worst. */
  ranking: string[];
  rationale: JudgeRationaleDto[];
  confidence: 'high' | 'medium' | 'low';
}

export type DaemonAgentPayload =
  | { type: 'status'; label: string; model?: string; ttftMs?: number; detail?: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'usage'; usage?: { input_tokens?: number; output_tokens?: number }; costUsd?: number; durationMs?: number }
  | { type: 'raw'; line: string };

export type ChatSseEvent =
  | SseTransportEvent<'start', ChatSseStartPayload>
  | SseTransportEvent<'agent', DaemonAgentPayload>
  | SseTransportEvent<'stdout', ChatSseChunkPayload>
  | SseTransportEvent<'stderr', ChatSseChunkPayload>
  | SseTransportEvent<'lint-result', ChatSseLintResultPayload>
  | SseTransportEvent<'critique-result', ChatSseCritiqueResultPayload>
  | SseTransportEvent<'judge-result', ChatSseJudgeResultPayload>
  | SseTransportEvent<'replay-gap', ChatSseReplayGapPayload>
  | SseTransportEvent<'error', SseErrorPayload>
  | SseTransportEvent<'end', ChatSseEndPayload>;
