import type { ProjectFile } from './files';
import type { PreviewCommentPosition } from './comments';

export type ChatRole = 'user' | 'assistant';

export interface ChatRequest {
  agentId: string;
  message: string;
  systemPrompt?: string;
  projectId?: string | null;
  conversationId?: string | null;
  assistantMessageId?: string | null;
  clientRequestId?: string | null;
  skillId?: string | null;
  designSystemId?: string | null;
  attachments?: string[];
  commentAttachments?: ChatCommentAttachment[];
  model?: string | null;
  reasoning?: string | null;
}

export interface ChatRunCreateRequest extends ChatRequest {
  projectId: string;
  conversationId: string;
  assistantMessageId: string;
  clientRequestId: string;
}

export type ChatRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface ChatRunCreateResponse {
  runId: string;
}

export interface ChatRunStatusResponse {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  assistantMessageId: string | null;
  agentId: string | null;
  status: ChatRunStatus;
  createdAt: number;
  updatedAt: number;
  exitCode?: number | null;
  signal?: string | null;
}

export interface ChatRunListResponse {
  runs: ChatRunStatusResponse[];
}

export interface ChatRunCancelResponse {
  ok: true;
}

export interface ChatAttachment {
  path: string;
  name: string;
  kind: 'image' | 'file';
  size?: number;
}

export interface ChatCommentAttachment {
  id: string;
  order: number;
  filePath: string;
  elementId: string;
  selector: string;
  label: string;
  comment: string;
  currentText: string;
  pagePosition: PreviewCommentPosition;
  htmlHint: string;
}

export type PersistedAgentEvent =
  | { kind: 'status'; label: string; detail?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number }
  | {
      kind: 'lint';
      // Per-artifact lint findings for the run. Each entry shows the
      // path the agent wrote and the structured findings from
      // `lint-artifact.ts`. The chat shell renders a P0/P1 badge and
      // exposes an "Auto-revise" button that re-prompts with
      // `agentMessage` so the agent can self-correct.
      artifacts: Array<{
        relPath: string;
        findings: Array<{
          severity: 'P0' | 'P1' | 'P2';
          id: string;
          message: string;
          fix: string;
          snippet?: string;
        }>;
      }>;
      hasP0: boolean;
      hasP1: boolean;
      totals: { p0: number; p1: number; p2: number };
      agentMessage: string;
    }
  | {
      // Visual self-critique block emitted by the agent when
      // OD_VISUAL_CRITIQUE is on. Complements the deterministic linter
      // findings: the linter catches what regex can match (default
      // indigo, emoji icons, lorem); the critique catches what
      // structural reasoning can — accent overuse in real layouts,
      // type hierarchy, brief alignment.
      kind: 'critique';
      verdict: 'ship' | 'revise';
      reasoning: string;
      findings: Array<{
        severity: 'P0' | 'P1' | 'P2';
        rule: string;
        evidence: string;
        fix: string;
      }>;
      totals: { p0: number; p1: number; p2: number };
      scores?: {
        philosophy: number;
        hierarchy: number;
        detail: number;
        functionality: number;
        innovation: number;
      };
    }
  | {
      // Multi-shot judge verdict emitted when OD_MULTI_SHOT is on.
      // Pairs with K `<artifact>` blocks the agent emits in the same
      // turn. Chat shell highlights the winner; user can switch.
      kind: 'judge';
      winner: string;
      axis: string;
      ranking: string[];
      rationale: Array<{
        variant: string;
        verdict: 'win' | 'runner-up' | 'last';
        why: string;
      }>;
      confidence: 'high' | 'medium' | 'low';
    }
  | { kind: 'raw'; line: string };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  agentId?: string;
  agentName?: string;
  events?: PersistedAgentEvent[];
  createdAt?: number;
  runId?: string;
  runStatus?: ChatRunStatus;
  lastRunEventId?: string;
  startedAt?: number;
  endedAt?: number;
  attachments?: ChatAttachment[];
  commentAttachments?: ChatCommentAttachment[];
  producedFiles?: ProjectFile[];
}
