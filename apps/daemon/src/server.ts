// @ts-nocheck
import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { composeSystemPrompt } from './prompts/system.js';
import { createCommandInvocation } from '@open-design/platform';
import {
  detectAgents,
  getAgentDef,
  isKnownModel,
  resolveAgentBin,
  sanitizeCustomModel,
} from './agents.js';
import { listSkills } from './skills.js';
import {
  listCodexPets,
  readCodexPetSpritesheet,
} from './codex-pets.js';
import { syncCommunityPets } from './community-pets-sync.js';
import { listDesignSystems, readDesignSystem } from './design-systems.js';
import { attachAcpSession } from './acp.js';
import { attachPiRpcSession } from './pi-rpc.js';
import { createClaudeStreamHandler } from './claude-stream.js';
import { createCopilotStreamHandler } from './copilot-stream.js';
import { createJsonEventStreamHandler } from './json-event-stream.js';
import { renderDesignSystemPreview } from './design-system-preview.js';
import { renderDesignSystemShowcase } from './design-system-showcase.js';
import { createChatRunService } from './runs.js';
import { importClaudeDesignZip } from './claude-design-import.js';
import { listPromptTemplates, readPromptTemplate } from './prompt-templates.js';
import { buildDocumentPreview } from './document-preview.js';
import { lintArtifact, renderFindingsForAgent } from './lint-artifact.js';
import { lintRunArtifacts } from './post-run-lint.js';
import { computeCostUsd } from './pricing.js';
import { findFinalCritique } from './critique-parser.js';
import { findFinalJudge } from './judge-parser.js';
import {
  addProjectReference,
  listProjectReferences,
  removeProjectReference,
  toggleProjectReference,
} from './project-references.js';
import {
  aggregateUserTaste,
  aggregateProjectTaste,
  aggregateSessionTaste,
  recordTasteSignal,
  listTasteSignals,
  deleteTasteSignal,
  clearTasteScope,
} from './taste-memory.js';
import { deriveFeedbackSubjects } from './feedback.js';
import { loadCraftSections } from './craft.js';
import { generateMedia } from './media.js';
import {
  AUDIO_DURATIONS_SEC,
  AUDIO_MODELS_BY_KIND,
  IMAGE_MODELS,
  MEDIA_ASPECTS,
  MEDIA_PROVIDERS,
  VIDEO_LENGTHS_SEC,
  VIDEO_MODELS,
} from './media-models.js';
import { readMaskedConfig, writeConfig } from './media-config.js';
import {
  decodeMultipartFilename,
  deleteProjectFile,
  ensureProject,
  listFiles,
  projectDir,
  readProjectFile,
  removeProjectDir,
  sanitizeName,
  writeProjectFile,
} from './projects.js';
import { validateArtifactManifestInput } from './artifact-manifest.js';
import { readCurrentAppVersionInfo } from './app-version.js';
import {
  deleteConversation,
  deletePreviewComment,
  deleteProject as dbDeleteProject,
  deleteTemplate,
  getConversation,
  getDeployment,
  getDeploymentById,
  getProject,
  getTemplate,
  insertConversation,
  insertProject,
  insertTemplate,
  listProjectsAwaitingInput,
  listConversations,
  listDeployments,
  listLatestProjectRunStatuses,
  listMessages,
  listPreviewComments,
  listProjects,
  listTabs,
  listTemplates,
  openDatabase,
  setTabs,
  updateConversation,
  updatePreviewCommentStatus,
  updateProject,
  upsertDeployment,
  upsertMessage,
  upsertPreviewComment,
} from './db.js';
import {
  buildDeployFileSet,
  checkDeploymentUrl,
  DeployError,
  deployToVercel,
  prepareDeployPreflight,
  publicDeployConfig,
  readVercelConfig,
  VERCEL_PROVIDER_ID,
  writeVercelConfig,
} from './deploy.js';

/** @typedef {import('@open-design/contracts').ApiErrorCode} ApiErrorCode */
/** @typedef {import('@open-design/contracts').ApiError} ApiError */
/** @typedef {import('@open-design/contracts').ApiErrorResponse} ApiErrorResponse */
/** @typedef {import('@open-design/contracts').ChatRequest} ChatRequest */
/** @typedef {import('@open-design/contracts').ChatSseEvent} ChatSseEvent */
/** @typedef {import('@open-design/contracts').ProxyStreamRequest} ProxyStreamRequest */
/** @typedef {import('@open-design/contracts').ProxySseEvent} ProxySseEvent */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export function resolveProjectRoot(moduleDir: string): string {
  const base = path.basename(moduleDir);
  const daemonDir = base === 'dist' || base === 'src'
    ? path.dirname(moduleDir)
    : moduleDir;
  return path.resolve(daemonDir, '../..');
}

const PROJECT_ROOT = resolveProjectRoot(__dirname);
const RESOURCE_ROOT_ENV = 'OD_RESOURCE_ROOT';

export function normalizeCommentAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw, index) => {
      if (!raw || typeof raw !== 'object') return null;
      const filePath = cleanString(raw.filePath);
      const elementId = cleanString(raw.elementId);
      const selector = cleanString(raw.selector);
      const label = cleanString(raw.label);
      const comment = cleanString(raw.comment);
      if (!filePath || !elementId || !selector || !comment) return null;
      return {
        id: cleanString(raw.id) || `comment-${index + 1}`,
        order: Number.isFinite(raw.order) ? Math.max(1, Math.round(raw.order)) : index + 1,
        filePath,
        elementId,
        selector,
        label,
        comment,
        currentText: compactString(raw.currentText, 160),
        pagePosition: normalizeAttachmentPosition(raw.pagePosition),
        htmlHint: compactString(raw.htmlHint, 180),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

export function renderCommentAttachmentHint(commentAttachments) {
  if (!commentAttachments.length) return '';
  const lines = [
    '',
    '',
    '<attached-preview-comments>',
    'Scope: edit the target element by default. Use the smallest necessary parent wrapper only if the target cannot satisfy the comment. Preserve stable ids and unrelated siblings.',
  ];
  for (const item of commentAttachments) {
    lines.push(
      '',
      `${item.order}. ${item.elementId}`,
      `file: ${item.filePath}`,
      `selector: ${item.selector}`,
      `label: ${item.label || '(unlabeled)'}`,
      `position: ${formatAttachmentPosition(item.pagePosition)}`,
      `currentText: ${item.currentText || '(empty)'}`,
      `htmlHint: ${item.htmlHint || '(none)'}`,
      `comment: ${item.comment}`,
    );
  }
  lines.push('</attached-preview-comments>');
  return lines.join('\n');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function compactString(value, max) {
  const text = cleanString(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalizeAttachmentPosition(input) {
  const value = input && typeof input === 'object' ? input : {};
  return {
    x: finiteAttachmentNumber(value.x),
    y: finiteAttachmentNumber(value.y),
    width: finiteAttachmentNumber(value.width),
    height: finiteAttachmentNumber(value.height),
  };
}

function finiteAttachmentNumber(value) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function formatAttachmentPosition(position) {
  return `x=${position.x}, y=${position.y}, width=${position.width}, height=${position.height}`;
}

function isPathWithin(base, target) {
  const relativePath = path.relative(path.resolve(base), path.resolve(target));
  return relativePath === '' || (relativePath.length > 0 && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveProcessResourcesPath() {
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    return process.resourcesPath;
  }

  // Packaged daemon sidecars run under the bundled Node binary rather than the
  // Electron root process, so `process.resourcesPath` is unavailable there.
  // Infer the macOS app Resources directory from that bundled Node path.
  const resourcesMarker = `${path.sep}Contents${path.sep}Resources${path.sep}`;
  const markerIndex = process.execPath.indexOf(resourcesMarker);
  if (markerIndex !== -1) {
    return process.execPath.slice(0, markerIndex + resourcesMarker.length - 1);
  }

  const normalizedExecPath = process.execPath.toLowerCase();
  const windowsResourceBinMarker = `${path.sep}resources${path.sep}open-design${path.sep}bin${path.sep}`.toLowerCase();
  const windowsMarkerIndex = normalizedExecPath.indexOf(windowsResourceBinMarker);
  if (windowsMarkerIndex !== -1) {
    return process.execPath.slice(0, windowsMarkerIndex + `${path.sep}resources`.length);
  }

  return null;
}

export function resolveDaemonResourceRoot({
  configured = process.env[RESOURCE_ROOT_ENV],
  safeBases = [PROJECT_ROOT, resolveProcessResourcesPath()],
} = {}) {
  if (!configured || configured.length === 0) return null;

  const resolved = path.resolve(configured);
  const normalizedSafeBases = safeBases
    .filter((base) => typeof base === 'string' && base.length > 0)
    .map((base) => path.resolve(base));

  if (!normalizedSafeBases.some((base) => isPathWithin(base, resolved))) {
    throw new Error(`${RESOURCE_ROOT_ENV} must be under the workspace root or app resources path`);
  }

  return resolved;
}

function resolveDaemonResourceDir(resourceRoot, segment, fallback) {
  return resourceRoot ? path.join(resourceRoot, segment) : fallback;
}

const DAEMON_RESOURCE_ROOT = resolveDaemonResourceRoot();
// Built web app lives in `out/` — that's where Next.js writes the static
// export configured in next.config.ts. The folder name used to be `dist/`
// when this project shipped with Vite; the daemon serves whatever the
// frontend toolchain emits, no further config needed.
const STATIC_DIR = path.join(PROJECT_ROOT, 'apps', 'web', 'out');
const OD_BIN = path.join(PROJECT_ROOT, 'apps', 'daemon', 'dist', 'cli.js');
const SKILLS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'skills',
  path.join(PROJECT_ROOT, 'skills'),
);
const DESIGN_SYSTEMS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'design-systems',
  path.join(PROJECT_ROOT, 'design-systems'),
);
const CRAFT_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'craft',
  path.join(PROJECT_ROOT, 'craft'),
);
const FRAMES_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'frames',
  path.join(PROJECT_ROOT, 'assets', 'frames'),
);
// Curated pets baked into the repo via `scripts/bake-community-pets.ts`.
// `listCodexPets` scans this in addition to `~/.codex/pets/` so the
// "Recently hatched" grid is non-empty out-of-the-box and users do not
// need to hit the "Download community pets" button to try a few pets.
const BUNDLED_PETS_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'community-pets',
  path.join(PROJECT_ROOT, 'assets', 'community-pets'),
);
const PROMPT_TEMPLATES_DIR = resolveDaemonResourceDir(
  DAEMON_RESOURCE_ROOT,
  'prompt-templates',
  path.join(PROJECT_ROOT, 'prompt-templates'),
);
const RUNTIME_DATA_DIR = process.env.OD_DATA_DIR
  ? path.resolve(PROJECT_ROOT, process.env.OD_DATA_DIR)
  : path.join(PROJECT_ROOT, '.od');
const ARTIFACTS_DIR = path.join(RUNTIME_DATA_DIR, 'artifacts');
const PROJECTS_DIR = path.join(RUNTIME_DATA_DIR, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

export const SSE_KEEPALIVE_INTERVAL_MS = 25_000;

export function normalizeProjectDisplayStatus(status) {
  return status === 'starting' || status === 'queued' ? 'running' : status;
}

export function composeProjectDisplayStatus(baseStatus, awaitingInputProjects, projectId) {
  if (baseStatus.value === 'succeeded' && awaitingInputProjects.has(projectId)) {
    return { ...baseStatus, value: 'awaiting_input' };
  }
  return {
    ...baseStatus,
    value: normalizeProjectDisplayStatus(baseStatus.value),
  };
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 * @returns {ApiError}
 */
export function createCompatApiError(code, message, init = {}) {
  return { code, message, ...init };
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 * @returns {ApiErrorResponse}
 */
export function createCompatApiErrorResponse(code, message, init = {}) {
  return { error: createCompatApiError(code, message, init) };
}

/**
 * @param {import('express').Response} res
 * @param {number} status
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 */
function sendApiError(res, status, code, message, init = {}) {
  return res.status(status).json(createCompatApiErrorResponse(code, message, init));
}

/**
 * @param {ApiErrorCode} code
 * @param {string} message
 * @param {Omit<ApiError, 'code' | 'message'>} [init]
 */
function createSseErrorPayload(code, message, init = {}) {
  return { message, error: createCompatApiError(code, message, init) };
}

const UPLOAD_DIR = path.join(os.tmpdir(), 'od-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const importUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Project-scoped multi-file upload. Lands files directly in the project
// folder (flat — same shape FileWorkspace expects), so the composer's
// pasted/dropped/picked images become referenceable filenames the agent
// can Read or @-mention without any cross-folder gymnastics.
const projectUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const dir = await ensureProject(PROJECTS_DIR, req.params.id);
        cb(null, dir);
      } catch (err) {
        cb(err, '');
      }
    },
    filename: (_req, file, cb) => {
      // multer@1 hands us latin1-decoded multipart filenames; restore the
      // original UTF-8 so the response (and the on-disk name) preserves
      // non-ASCII characters instead of mangling them. Then run the
      // shared sanitiser and prepend a base36 timestamp so multiple
      // uploads with the same original name don't clobber each other.
      file.originalname = decodeMultipartFilename(file.originalname);
      const safe = sanitizeName(file.originalname);
      cb(null, `${Date.now().toString(36)}-${safe}`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },  // 200MB — covers the largest design assets we expect (PPTX/PDF/raw images)
});

function handleProjectUpload(req, res, next) {
  projectUpload.array('files', 12)(req, res, (err) => {
    if (err) {
      return sendMulterError(res, err);
    }
    next();
  });
}

function sendMulterError(res, err) {
  if (err instanceof multer.MulterError) {
    const code = err.code || 'UPLOAD_ERROR';
    const statusByCode = {
      LIMIT_FILE_SIZE: 413,
      LIMIT_FILE_COUNT: 400,
      LIMIT_UNEXPECTED_FILE: 400,
      LIMIT_PART_COUNT: 400,
      LIMIT_FIELD_KEY: 400,
      LIMIT_FIELD_VALUE: 400,
      LIMIT_FIELD_COUNT: 400,
    };
    const errorByCode = {
      LIMIT_FILE_SIZE: 'file too large',
      LIMIT_FILE_COUNT: 'too many files',
      LIMIT_UNEXPECTED_FILE: 'unexpected file field',
      LIMIT_PART_COUNT: 'too many form parts',
      LIMIT_FIELD_KEY: 'field name too long',
      LIMIT_FIELD_VALUE: 'field value too long',
      LIMIT_FIELD_COUNT: 'too many form fields',
    };
    const status = statusByCode[code] ?? 400;
    const message = errorByCode[code] ?? 'upload failed';
    return sendApiError(
      res,
      status,
      code === 'LIMIT_FILE_SIZE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
      message,
      { details: { legacyCode: code } },
    );
  }

  if (err) {
    return sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
  }

  return sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
}

const mediaTasks = new Map();
const TASK_TTL_AFTER_DONE_MS = 10 * 60 * 1000;

function createMediaTask(taskId, projectId, info = {}) {
  const task = {
    id: taskId,
    projectId,
    status: 'queued',
    surface: info.surface,
    model: info.model,
    progress: [],
    file: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    waiters: new Set(),
  };
  mediaTasks.set(taskId, task);
  return task;
}

function appendTaskProgress(task, line) {
  task.progress.push(line);
  notifyTaskWaiters(task);
}

function notifyTaskWaiters(task) {
  const wakers = Array.from(task.waiters);
  for (const w of wakers) {
    try {
      w();
    } catch {
      // Never let one bad waiter block the rest.
    }
  }
  if (
    (task.status === 'done' || task.status === 'failed') &&
    !task._gcScheduled
  ) {
    task._gcScheduled = true;
    setTimeout(() => {
      if (task.waiters.size === 0) mediaTasks.delete(task.id);
    }, TASK_TTL_AFTER_DONE_MS).unref?.();
  }
}

export function createSseResponse(res, { keepAliveIntervalMs = SSE_KEEPALIVE_INTERVAL_MS } = {}) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const canWrite = () => !res.destroyed && !res.writableEnded;
  const writeKeepAlive = () => {
    if (canWrite()) {
      res.write(': keepalive\n\n');
      return true;
    }
    return false;
  };

  let heartbeat = null;
  if (keepAliveIntervalMs > 0) {
    heartbeat = setInterval(writeKeepAlive, keepAliveIntervalMs);
    heartbeat.unref?.();
  }

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);

  return {
    /** @param {ChatSseEvent['event'] | ProxySseEvent['event'] | string} event */
    send(event, data, id = null) {
      if (!canWrite()) return false;
      if (id !== null && id !== undefined) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    writeKeepAlive,
    cleanup,
    end() {
      cleanup();
      if (canWrite()) {
        res.end();
      }
    },
  };
}

export async function startServer({ port = 7456, host = process.env.OD_BIND_HOST || '0.0.0.0', returnServer = false } = {}) {
  let resolvedPort = port;
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const db = openDatabase(PROJECT_ROOT, { dataDir: RUNTIME_DATA_DIR });

  if (process.env.OD_CODEX_DISABLE_PLUGINS === '1') {
    console.log('[od] Codex plugins disabled via OD_CODEX_DISABLE_PLUGINS=1');
  }

  // Warm agent-capability probes (e.g. whether the installed Claude Code
  // build advertises --include-partial-messages) so the first /api/chat
  // hits a populated cache even if /api/agents hasn't been called yet.
  void detectAgents().catch(() => {});

  if (fs.existsSync(STATIC_DIR)) {
    app.use(express.static(STATIC_DIR));
  }

  app.get('/api/health', async (_req, res) => {
    const versionInfo = await readCurrentAppVersionInfo();
    res.json({ ok: true, version: versionInfo.version });
  });

  // Split health probes — see specs/current/master-plan-2026-05.md T1.3.
  //   /health/live  — process is up enough to answer HTTP. Used by the
  //                   supervisor for auto-restart decisions.
  //   /health/ready — DB is open AND at least one agent adapter resolved.
  //                   Used by the web UI to decide whether to enable the
  //                   chat composer; returns 503 + structured reason
  //                   while the daemon is warming up.
  app.get('/health/live', (_req, res) => {
    res.json({ live: true, pid: process.pid, uptimeSec: Math.round(process.uptime()) });
  });

  app.get('/health/ready', async (_req, res) => {
    const reasons: string[] = [];
    let dbOk = false;
    try {
      // Cheap round-trip — sqlite responds in microseconds when open.
      db.prepare('SELECT 1 AS ok').get();
      dbOk = true;
    } catch (err) {
      reasons.push(`db: ${String((err as Error).message ?? err)}`);
    }
    let agentsOk = false;
    let agentCount = 0;
    try {
      const agents = await detectAgents();
      agentCount = Array.isArray(agents) ? agents.length : 0;
      // "Ready" requires at least one *installed* agent. Detected-but-
      // not-installed entries do not count — they cannot serve a chat.
      agentsOk = Array.isArray(agents) && agents.some((a) => a && a.installed !== false && a.bin);
      if (!agentsOk) reasons.push('agents: none installed');
    } catch (err) {
      reasons.push(`agents: ${String((err as Error).message ?? err)}`);
    }
    const ready = dbOk && agentsOk;
    res.status(ready ? 200 : 503).json({
      ready,
      checks: {
        db: dbOk,
        agents: agentsOk,
        agentCount,
      },
      reasons: reasons.length > 0 ? reasons : undefined,
    });
  });

  app.get('/api/version', async (_req, res) => {
    const version = await readCurrentAppVersionInfo();
    res.json({ version });
  });

  // ---- Projects (DB-backed) -------------------------------------------------

  app.get('/api/projects', (_req, res) => {
    try {
      const latestRunStatuses = listLatestProjectRunStatuses(db);
      const awaitingInputProjects = listProjectsAwaitingInput(db);
      const activeRunStatuses = new Map();
      for (const run of design.runs.list()) {
        if (!run.projectId) continue;
        const runStatus = projectStatusFromRun(run);
        if (design.runs.isTerminal(run.status)) {
          const existing = latestRunStatuses.get(run.projectId);
          if (!existing || run.updatedAt > (existing.updatedAt ?? 0)) {
            latestRunStatuses.set(run.projectId, runStatus);
          }
        } else {
          const existing = activeRunStatuses.get(run.projectId);
          if (!existing || run.updatedAt > (existing.updatedAt ?? 0)) {
            activeRunStatuses.set(run.projectId, runStatus);
          }
        }
      }
      /** @type {import('@open-design/contracts').ProjectsResponse} */
      const body = {
        projects: listProjects(db).map((project) => ({
          ...project,
          status: composeProjectDisplayStatus(
            activeRunStatuses.get(project.id) ?? latestRunStatuses.get(project.id) ?? { value: 'not_started' },
            awaitingInputProjects,
            project.id,
          ),
        })),
      };
      res.json(body);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err));
    }
  });

  function projectStatusFromRun(run) {
    return {
      value: normalizeProjectDisplayStatus(run.status),
      updatedAt: run.updatedAt,
      runId: run.id,
    };
  }

  app.post('/api/projects', async (req, res) => {
    try {
      const { id, name, skillId, designSystemId, pendingPrompt, metadata } =
        req.body || {};
      if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid project id');
      }
      if (typeof name !== 'string' || !name.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'name required');
      }
      const now = Date.now();
      const project = insertProject(db, {
        id,
        name: name.trim(),
        skillId: skillId ?? null,
        designSystemId: designSystemId ?? null,
        pendingPrompt: pendingPrompt || null,
        metadata: metadata && typeof metadata === 'object' ? metadata : null,
        createdAt: now,
        updatedAt: now,
      });
      // Seed a default conversation so the UI always has somewhere to write.
      const cid = randomId();
      insertConversation(db, {
        id: cid,
        projectId: id,
        title: null,
        createdAt: now,
        updatedAt: now,
      });
      // For "from template" projects, seed the chosen template's snapshot
      // HTML into the new project folder so the agent can Read/edit files
      // on disk (the system prompt also embeds them, but a real on-disk
      // copy lets the agent treat them as the project's working state).
      if (
        metadata &&
        typeof metadata === 'object' &&
        metadata.kind === 'template' &&
        typeof metadata.templateId === 'string'
      ) {
        const tpl = getTemplate(db, metadata.templateId);
        if (tpl && Array.isArray(tpl.files) && tpl.files.length > 0) {
          await ensureProject(PROJECTS_DIR, id);
          for (const f of tpl.files) {
            if (!f || typeof f.name !== 'string' || typeof f.content !== 'string') {
              continue;
            }
            try {
              await writeProjectFile(
                PROJECTS_DIR,
                id,
                f.name,
                Buffer.from(f.content, 'utf8'),
              );
            } catch {
              // Skip individual file failures — the template snapshot is
              // best-effort; the agent still has the embedded copy.
            }
          }
        }
      }
      /** @type {import('@open-design/contracts').CreateProjectResponse} */
      const body = { project, conversationId: cid };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.post('/api/import/claude-design', importUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'zip file required' });
      const originalName = req.file.originalname || 'Claude Design export.zip';
      if (!/\.zip$/i.test(originalName)) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'expected a .zip file' });
      }
      const id = randomId();
      const now = Date.now();
      const baseName = originalName.replace(/\.zip$/i, '').trim() || 'Claude Design import';
      const imported = await importClaudeDesignZip(req.file.path, projectDir(PROJECTS_DIR, id));
      fs.promises.unlink(req.file.path).catch(() => {});

      const project = insertProject(db, {
        id,
        name: baseName,
        skillId: null,
        designSystemId: null,
        pendingPrompt: `Imported from Claude Design ZIP: ${originalName}. Continue editing ${imported.entryFile}.`,
        metadata: {
          kind: 'prototype',
          importedFrom: 'claude-design',
          entryFile: imported.entryFile,
          sourceFileName: originalName,
        },
        createdAt: now,
        updatedAt: now,
      });
      const cid = randomId();
      insertConversation(db, {
        id: cid,
        projectId: id,
        title: 'Imported Claude Design project',
        createdAt: now,
        updatedAt: now,
      });
      setTabs(db, id, [imported.entryFile], imported.entryFile);
      res.json({
        project,
        conversationId: cid,
        entryFile: imported.entryFile,
        files: imported.files,
      });
    } catch (err) {
      if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = getProject(db, req.params.id);
    if (!project) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    /** @type {import('@open-design/contracts').ProjectResponse} */
    const body = { project };
    res.json(body);
  });

  app.patch('/api/projects/:id', (req, res) => {
    try {
      const patch = req.body || {};
      const project = updateProject(db, req.params.id, patch);
      if (!project) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
      /** @type {import('@open-design/contracts').ProjectResponse} */
      const body = { project };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.delete('/api/projects/:id', async (req, res) => {
    try {
      dbDeleteProject(db, req.params.id);
      await removeProjectDir(PROJECTS_DIR, req.params.id).catch(() => {});
      /** @type {import('@open-design/contracts').OkResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  // ---- Conversations --------------------------------------------------------

  app.get('/api/projects/:id/conversations', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json({ conversations: listConversations(db, req.params.id) });
  });

  app.post('/api/projects/:id/conversations', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const { title } = req.body || {};
    const now = Date.now();
    const conv = insertConversation(db, {
      id: randomId(),
      projectId: req.params.id,
      title: typeof title === 'string' ? title.trim() || null : null,
      createdAt: now,
      updatedAt: now,
    });
    res.json({ conversation: conv });
  });

  app.patch('/api/projects/:id/conversations/:cid', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'not found' });
    }
    const updated = updateConversation(db, req.params.cid, req.body || {});
    res.json({ conversation: updated });
  });

  app.delete('/api/projects/:id/conversations/:cid', (req, res) => {
    const conv = getConversation(db, req.params.cid);
    if (!conv || conv.projectId !== req.params.id) {
      return res.status(404).json({ error: 'not found' });
    }
    deleteConversation(db, req.params.cid);
    res.json({ ok: true });
  });

  // ---- Messages -------------------------------------------------------------

  app.get(
    '/api/projects/:id/conversations/:cid/messages',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      res.json({ messages: listMessages(db, req.params.cid) });
    },
  );

  app.put(
    '/api/projects/:id/conversations/:cid/messages/:mid',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const m = req.body || {};
      if (m.id && m.id !== req.params.mid) {
        return res.status(400).json({ error: 'id mismatch' });
      }
      const saved = upsertMessage(db, req.params.cid, { ...m, id: req.params.mid });
      // Bump the parent project's updatedAt so the project list re-orders.
      updateProject(db, req.params.id, {});
      res.json({ message: saved });
    },
  );

  // ---- Preview comments ----------------------------------------------------

  app.get(
    '/api/projects/:id/conversations/:cid/comments',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      res.json({ comments: listPreviewComments(db, req.params.id, req.params.cid) });
    },
  );

  app.post(
    '/api/projects/:id/conversations/:cid/comments',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      try {
        const comment = upsertPreviewComment(db, req.params.id, req.params.cid, req.body || {});
        updateProject(db, req.params.id, {});
        res.json({ comment });
      } catch (err) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.patch(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      try {
        const comment = updatePreviewCommentStatus(
          db,
          req.params.id,
          req.params.cid,
          req.params.commentId,
          req.body?.status,
        );
        if (!comment) return res.status(404).json({ error: 'comment not found' });
        updateProject(db, req.params.id, {});
        res.json({ comment });
      } catch (err) {
        res.status(400).json({ error: String(err?.message || err) });
      }
    },
  );

  app.delete(
    '/api/projects/:id/conversations/:cid/comments/:commentId',
    (req, res) => {
      const conv = getConversation(db, req.params.cid);
      if (!conv || conv.projectId !== req.params.id) {
        return res.status(404).json({ error: 'conversation not found' });
      }
      const ok = deletePreviewComment(db, req.params.id, req.params.cid, req.params.commentId);
      if (!ok) return res.status(404).json({ error: 'comment not found' });
      updateProject(db, req.params.id, {});
      res.json({ ok: true });
    },
  );

  // ---- Tabs -----------------------------------------------------------------

  app.get('/api/projects/:id/tabs', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json(listTabs(db, req.params.id));
  });

  app.put('/api/projects/:id/tabs', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const { tabs = [], active = null } = req.body || {};
    if (!Array.isArray(tabs) || !tabs.every((t) => typeof t === 'string')) {
      return res.status(400).json({ error: 'tabs must be string[]' });
    }
    const result = setTabs(
      db,
      req.params.id,
      tabs,
      typeof active === 'string' ? active : null,
    );
    res.json(result);
  });

  // ---- Project references (T2.1) ------------------------------------------
  // User-curated taste signals scoped to a project. The MVP supports
  // starring design-systems/* slugs; uploaded screenshots, URL
  // snapshots, and Figma nodes are accepted shape-wise but populated
  // by follow-ups (T2.1b, T2.1c).

  app.get('/api/projects/:id/references', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json({ references: listProjectReferences(db, req.params.id) });
  });

  app.post('/api/projects/:id/references', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    try {
      const ref = addProjectReference(db, req.params.id, req.body || {});
      res.status(201).json(ref);
    } catch (err) {
      const status = err && err.code === 'BAD_KIND' ? 400
        : err && err.code === 'BAD_VALUE' ? 400
        : 500;
      res.status(status).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.delete('/api/projects/:id/references/:refId', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const removed = removeProjectReference(db, req.params.id, req.params.refId);
    res.json({ ok: true, removed });
  });

  // ---- Taste memory (T2.2) -------------------------------------------------
  // Inspector + manual-edit endpoints. Memory is normally derived
  // from events (judge / lint / reference / future feedback), so the
  // typical user never POSTs here directly — but the inspector UI
  // (deferred to T2.2b) lets them list, delete, or clear scopes when
  // the profile drifts into the wrong shape.

  app.get('/api/taste/aggregate', (req, res) => {
    const scope = String(req.query.scope || 'user');
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
    if (scope === 'user') {
      return res.json({ scope, aggregates: aggregateUserTaste(db) });
    }
    if (scope === 'project' && projectId) {
      return res.json({ scope, projectId, aggregates: aggregateProjectTaste(db, projectId) });
    }
    if (scope === 'session' && sessionId) {
      return res.json({ scope, sessionId, aggregates: aggregateSessionTaste(db, sessionId) });
    }
    res.status(400).json({ error: 'scope must be user|project|session with appropriate id' });
  });

  app.get('/api/taste/signals', (req, res) => {
    const scope = String(req.query.scope || 'user');
    if (scope !== 'user' && scope !== 'project' && scope !== 'session') {
      return res.status(400).json({ error: 'scope must be user|project|session' });
    }
    const scopeId = typeof req.query.id === 'string' ? req.query.id : null;
    const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 200;
    res.json({ signals: listTasteSignals(db, scope, scopeId, Math.min(Math.max(1, limit), 1000)) });
  });

  app.post('/api/taste/signals', (req, res) => {
    try {
      const { scope, projectId, sessionId, subject, polarity, source, payload } = req.body || {};
      const result = recordTasteSignal(db, {
        scope,
        projectId,
        sessionId,
        subject,
        polarity,
        source: source ?? 'manual',
        payload: payload ?? null,
      });
      if (!result) {
        return res.status(400).json({ error: 'invalid signal — check scope/subject/polarity/source' });
      }
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.delete('/api/taste/signals/:id', (req, res) => {
    const removed = deleteTasteSignal(db, req.params.id);
    res.json({ ok: true, removed });
  });

  app.delete('/api/taste/scope/:scope', (req, res) => {
    const scope = String(req.params.scope);
    if (scope !== 'user' && scope !== 'project' && scope !== 'session') {
      return res.status(400).json({ error: 'scope must be user|project|session' });
    }
    const id = typeof req.query.id === 'string' ? req.query.id : null;
    const removed = clearTasteScope(db, scope, id);
    res.json({ ok: true, removed });
  });

  // ---- Feedback (T2.3) -----------------------------------------------------
  // Explicit thumbs-up/down on an assistant turn. Records one or more
  // taste signals against the run's context (skill, design system,
  // brief mood when present). The optional `why` text is stored in the
  // signal payload for the inspector and for future embedding-based
  // retrieval (deferred to T3.3).
  //
  // Why multiple signals per click. A thumbs-up that only records "I
  // liked run-123" is too generic to be useful. A thumbs-up that
  // records "+1 skill:magazine-deck", "+1 design-system:stripe" tells
  // the next session that THIS combination worked. Polarity is
  // ±1 across all derived subjects so the signed sum at aggregation
  // time reflects user verdict, not amplitude tricks.

  app.post('/api/feedback', (req, res) => {
    try {
      const body = req.body || {};
      const polarity = body.polarity === 1 || body.polarity === -1 ? body.polarity : null;
      if (polarity === null) {
        return res.status(400).json({ error: 'polarity must be 1 or -1' });
      }
      const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
      const conversationId = typeof body.conversationId === 'string' && body.conversationId ? body.conversationId : null;
      const why = typeof body.why === 'string' ? body.why.trim().slice(0, 500) : '';
      const runId = typeof body.runId === 'string' ? body.runId : null;

      // Derive subjects from the run context. Logic is extracted into
      // `deriveFeedbackSubjects` so it can be tested without standing
      // up the full daemon.
      const project = projectId ? getProject(db, projectId) : null;
      const subjects = deriveFeedbackSubjects({
        project,
        skillIdOverride: typeof body.skillId === 'string' ? body.skillId : null,
        designSystemIdOverride: typeof body.designSystemId === 'string' ? body.designSystemId : null,
      });

      const recordedIds: string[] = [];
      for (const subject of subjects) {
        const result = recordTasteSignal(db, {
          // Project signals when we have a project; user-level otherwise.
          // Why not always project: ad-hoc no-project chats still need
          // somewhere to land.
          scope: projectId ? 'project' : 'user',
          projectId,
          subject,
          polarity,
          source: 'feedback',
          payload: {
            why: why || undefined,
            runId,
            conversationId,
          },
        });
        if (result?.id) recordedIds.push(result.id);
      }

      // ALSO record the 'why' text against the user-level scope so
      // taste profile across all projects benefits. Subject is the
      // same as primary but scoped wider — this is the "explicit
      // signal carries 1.0 weight, implicit signals carry 0.5"
      // amplitude trick, but expressed as TWO records (user +
      // project) rather than weight magic.
      if (projectId && polarity) {
        for (const subject of subjects) {
          const result = recordTasteSignal(db, {
            scope: 'user',
            subject,
            polarity,
            source: 'feedback',
            payload: { why: why || undefined, runId, conversationId, mirroredFromProject: projectId },
          });
          if (result?.id) recordedIds.push(result.id);
        }
      }

      res.status(201).json({
        ok: true,
        polarity,
        subjects,
        recordedSignalIds: recordedIds,
      });
    } catch (err) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/projects/:id/references/toggle', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    try {
      const result = toggleProjectReference(db, req.params.id, req.body || {});
      // Taste-memory hook. Starring a reference is a positive signal
      // at the project level; un-starring is negative. Both are
      // explicit user actions, so they carry more weight per signal
      // than the implicit lint signals.
      try {
        const kind = String(req.body?.kind || '');
        const value = String(req.body?.value || '').trim();
        if (kind && value) {
          recordTasteSignal(db, {
            scope: 'project',
            projectId: req.params.id,
            subject: `${kind}:${value}`,
            polarity: result.state === 'added' ? 1 : -1,
            source: 'reference',
          });
        }
      } catch {
        // Never fail the toggle on memory recording errors.
      }
      if (result.state === 'added') {
        res.json({ state: 'added', reference: result.ref });
      } else {
        res.json({ state: 'removed' });
      }
    } catch (err) {
      const status = err && err.code === 'BAD_INPUT' ? 400 : 500;
      res.status(status).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  // ---- Templates ----------------------------------------------------------
  // User-saved snapshots of a project's HTML files. Surfaced in the
  // "From template" tab of the new-project panel so a user can spin up
  // a fresh project pre-seeded with another project's design as a
  // starting point. Created via the project's Share menu (snapshots
  // every .html file in the project folder at the moment of save).

  app.get('/api/templates', (_req, res) => {
    res.json({ templates: listTemplates(db) });
  });

  app.get('/api/templates/:id', (req, res) => {
    const t = getTemplate(db, req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({ template: t });
  });

  app.post('/api/templates', async (req, res) => {
    try {
      const { name, description, sourceProjectId } = req.body || {};
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name required' });
      }
      if (typeof sourceProjectId !== 'string') {
        return res.status(400).json({ error: 'sourceProjectId required' });
      }
      if (!getProject(db, sourceProjectId)) {
        return res.status(404).json({ error: 'source project not found' });
      }
      // Snapshot every HTML / sketch / text file in the source project.
      // We deliberately skip binary uploads — templates are about the
      // generated design, not the user's reference imagery.
      const files = await listFiles(PROJECTS_DIR, sourceProjectId);
      const snapshot = [];
      for (const f of files) {
        if (f.kind !== 'html' && f.kind !== 'text' && f.kind !== 'code') continue;
        const entry = await readProjectFile(PROJECTS_DIR, sourceProjectId, f.name);
        if (entry && Buffer.isBuffer(entry.buffer)) {
          snapshot.push({ name: f.name, content: entry.buffer.toString('utf8') });
        }
      }
      const t = insertTemplate(db, {
        id: randomId(),
        name: name.trim(),
        description: typeof description === 'string' ? description : null,
        sourceProjectId,
        files: snapshot,
        createdAt: Date.now(),
      });
      res.json({ template: t });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.delete('/api/templates/:id', (req, res) => {
    deleteTemplate(db, req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/agents', async (_req, res) => {
    try {
      const list = await detectAgents();
      res.json({ agents: list });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/skills', async (_req, res) => {
    try {
      const skills = await listSkills(SKILLS_DIR);
      // Strip full body + on-disk dir from the listing — frontend fetches the
      // body via /api/skills/:id when needed (keeps the listing payload small).
      res.json({
        skills: skills.map(({ body, dir: _dir, ...rest }) => ({
          ...rest,
          hasBody: typeof body === 'string' && body.length > 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/skills/:id', async (req, res) => {
    try {
      const skills = await listSkills(SKILLS_DIR);
      const skill = skills.find((s) => s.id === req.params.id);
      if (!skill) return res.status(404).json({ error: 'skill not found' });
      const { dir: _dir, ...serializable } = skill;
      res.json(serializable);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Codex hatch-pet registry — pets packaged by the upstream `hatch-pet`
  // skill under `${CODEX_HOME:-$HOME/.codex}/pets/`. Surfaced so the web
  // pet settings can offer one-click adoption of recently-hatched pets.
  app.get('/api/codex-pets', async (_req, res) => {
    try {
      const result = await listCodexPets({
        baseUrl: '',
        bundledRoot: BUNDLED_PETS_DIR,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // One-click community sync. Hits the Codex Pet Share + j20 Hatchery
  // catalogs and drops every pet into `${CODEX_HOME:-$HOME/.codex}/pets/`
  // so `GET /api/codex-pets` (and the web Pet settings) pick them up
  // immediately. The body is intentionally tiny — we keep the heavier
  // tuning knobs (`--limit`, `--concurrency`) on the CLI script and
  // only surface `force` + `source` here.
  app.post('/api/codex-pets/sync', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const sourceRaw = typeof body.source === 'string' ? body.source : 'all';
      const source =
        sourceRaw === 'petshare' || sourceRaw === 'hatchery'
          ? sourceRaw
          : 'all';
      const result = await syncCommunityPets({
        source,
        force: Boolean(body.force),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String((err && err.message) || err) });
    }
  });

  app.get('/api/codex-pets/:id/spritesheet', async (req, res) => {
    try {
      const sheet = await readCodexPetSpritesheet(req.params.id, {
        bundledRoot: BUNDLED_PETS_DIR,
      });
      if (!sheet) {
        return res
          .status(404)
          .type('text/plain')
          .send('codex pet spritesheet not found');
      }
      const mime =
        sheet.ext === 'webp'
          ? 'image/webp'
          : sheet.ext === 'gif'
            ? 'image/gif'
            : 'image/png';
      res.type(mime);
      // Same-origin callers (the web app proxies `/api/*` through to
      // the daemon, so PetSettings adoption fetches arrive same-origin)
      // do not need any CORS header here. We only echo
      // `Access-Control-Allow-Origin` for sandboxed iframes / data:
      // URIs (Origin: null) which need it to draw the bytes onto a
      // canvas without tainting. Local pet bytes should not be exposed
      // to arbitrary third-party origins via a wildcard ACAO.
      if (req.headers.origin === 'null') {
        res.setHeader('Access-Control-Allow-Origin', 'null');
      }
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(sheet.absPath);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.get('/api/design-systems', async (_req, res) => {
    try {
      const systems = await listDesignSystems(DESIGN_SYSTEMS_DIR);
      res.json({
        designSystems: systems.map(({ body, ...rest }) => rest),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id', async (req, res) => {
    try {
      const body = await readDesignSystem(DESIGN_SYSTEMS_DIR, req.params.id);
      if (body === null) return res.status(404).json({ error: 'design system not found' });
      res.json({ id: req.params.id, body });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/prompt-templates', async (_req, res) => {
    try {
      const templates = await listPromptTemplates(PROMPT_TEMPLATES_DIR);
      res.json({
        promptTemplates: templates.map(({ prompt: _prompt, ...rest }) => rest),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/prompt-templates/:surface/:id', async (req, res) => {
    try {
      const tpl = await readPromptTemplate(
        PROMPT_TEMPLATES_DIR,
        req.params.surface,
        req.params.id,
      );
      if (!tpl) return res.status(404).json({ error: 'prompt template not found' });
      res.json({ promptTemplate: tpl });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Showcase HTML for a design system — palette swatches, typography
  // samples, sample components, and the full DESIGN.md rendered as prose.
  // Built at request time from the on-disk DESIGN.md so any update to the
  // file shows up on the next view, no rebuild needed.
  app.get('/api/design-systems/:id/preview', async (req, res) => {
    try {
      const body = await readDesignSystem(DESIGN_SYSTEMS_DIR, req.params.id);
      if (body === null) return res.status(404).type('text/plain').send('not found');
      const html = renderDesignSystemPreview(req.params.id, body);
      res.type('text/html').send(html);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Marketing-style showcase derived from the same DESIGN.md — full landing
  // page parameterised by the system's tokens. Same lazy-render strategy as
  // /preview: built at request time, no caching.
  app.get('/api/design-systems/:id/showcase', async (req, res) => {
    try {
      const body = await readDesignSystem(DESIGN_SYSTEMS_DIR, req.params.id);
      if (body === null) return res.status(404).type('text/plain').send('not found');
      const html = renderDesignSystemShowcase(req.params.id, body);
      res.type('text/html').send(html);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Pre-built example HTML for a skill — what a typical artifact from this
  // skill looks like. Lets users browse skills without running an agent.
  //
  // The skill's `id` (from SKILL.md frontmatter `name`) can differ from its
  // on-disk folder name (e.g. id `magazine-web-ppt` lives in `skills/guizang-ppt/`),
  // so we resolve the actual directory via listSkills() rather than guessing.
  //
  // Resolution order:
  //   1. <skillDir>/example.html — fully-baked static example (preferred)
  //   2. <skillDir>/assets/template.html  +
  //      <skillDir>/assets/example-slides.html — assemble at request time
  //      by replacing the `<!-- SLIDES_HERE -->` marker with the snippet
  //      and patching the placeholder <title>. Lets a skill ship one
  //      canonical seed plus a small content fragment, so the example
  //      never drifts from the seed.
  //   3. <skillDir>/assets/template.html — raw template, no content slides
  //   4. <skillDir>/assets/index.html — generic fallback
  app.get('/api/skills/:id/example', async (req, res) => {
    try {
      const skills = await listSkills(SKILLS_DIR);
      const skill = skills.find((s) => s.id === req.params.id);
      if (!skill) {
        return res.status(404).type('text/plain').send('skill not found');
      }

      const baked = path.join(skill.dir, 'example.html');
      if (fs.existsSync(baked)) {
        return res.type('text/html').sendFile(baked);
      }

      const tpl = path.join(skill.dir, 'assets', 'template.html');
      const slides = path.join(skill.dir, 'assets', 'example-slides.html');
      if (fs.existsSync(tpl) && fs.existsSync(slides)) {
        try {
          const tplHtml = await fs.promises.readFile(tpl, 'utf8');
          const slidesHtml = await fs.promises.readFile(slides, 'utf8');
          const assembled = assembleExample(tplHtml, slidesHtml, skill.name);
          return res.type('text/html').send(assembled);
        } catch {
          // Fall through to raw template on read failure.
        }
      }
      if (fs.existsSync(tpl)) {
        return res.type('text/html').sendFile(tpl);
      }
      const idx = path.join(skill.dir, 'assets', 'index.html');
      if (fs.existsSync(idx)) {
        return res.type('text/html').sendFile(idx);
      }
      res
        .status(404)
        .type('text/plain')
        .send('no example.html, assets/template.html, or assets/index.html for this skill');
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.post('/api/upload', upload.array('images', 8), (req, res) => {
    const files = (req.files || []).map((f) => ({
      name: f.originalname,
      path: f.path,
      size: f.size,
    }));
    res.json({ files });
  });

  // Persist a generated artifact (HTML) to disk so the user can re-open it
  // in their browser or hand it off. Returns the on-disk path + a served URL.
  // The body is also passed through the anti-slop linter; findings are
  // returned alongside the path so the UI can render a P0/P1 badge and the
  // chat layer can splice them into a system reminder for the agent.
  app.post('/api/artifacts/save', (req, res) => {
    try {
      const { identifier, title, html } = req.body || {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ error: 'html required' });
      }
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const slug = sanitizeSlug(identifier || title || 'artifact');
      const dir = path.join(ARTIFACTS_DIR, `${stamp}-${slug}`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'index.html');
      fs.writeFileSync(file, html, 'utf8');
      const findings = lintArtifact(html);
      res.json({
        path: file,
        url: `/artifacts/${path.basename(dir)}/index.html`,
        lint: findings,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Standalone lint endpoint — POST raw HTML, get findings back.
  // The chat layer uses this to lint streamed-in artifacts without writing
  // them to disk first, so a P0 issue can be surfaced before save.
  app.post('/api/artifacts/lint', (req, res) => {
    try {
      const { html } = req.body || {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ error: 'html required' });
      }
      const findings = lintArtifact(html);
      res.json({
        findings,
        agentMessage: renderFindingsForAgent(findings),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.use('/artifacts', express.static(ARTIFACTS_DIR));

  // ---- Deploy --------------------------------------------------------------

  app.get('/api/deploy/config', async (_req, res) => {
    try {
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = publicDeployConfig(await readVercelConfig());
      res.json(body);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err?.message || err));
    }
  });

  app.put('/api/deploy/config', async (req, res) => {
    try {
      /** @type {import('@open-design/contracts').DeployConfigResponse} */
      const body = await writeVercelConfig(req.body || {});
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/deployments', (req, res) => {
    try {
      /** @type {import('@open-design/contracts').ProjectDeploymentsResponse} */
      const body = { deployments: listDeployments(db, req.params.id) };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/deploy', async (req, res) => {
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID } = req.body || {};
      if (providerId !== VERCEL_PROVIDER_ID) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'unsupported deploy provider');
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }

      const prior = getDeployment(db, req.params.id, fileName, providerId);
      const files = await buildDeployFileSet(PROJECTS_DIR, req.params.id, fileName);
      const result = await deployToVercel({
        config: await readVercelConfig(),
        files,
        projectId: req.params.id,
      });
      const now = Date.now();
      /** @type {import('@open-design/contracts').DeployProjectFileResponse} */
      const body = upsertDeployment(db, {
        id: prior?.id ?? randomUUID(),
        projectId: req.params.id,
        fileName,
        providerId,
        url: result.url,
        deploymentId: result.deploymentId,
        deploymentCount: (prior?.deploymentCount ?? 0) + 1,
        target: 'preview',
        status: result.status,
        statusMessage: result.statusMessage,
        reachableAt: result.reachableAt,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      });
      res.json(body);
    } catch (err) {
      const status = err instanceof DeployError ? err.status : 400;
      const init = err instanceof DeployError && err.details ? { details: err.details } : {};
      sendApiError(res, status, status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST', String(err?.message || err), init);
    }
  });

  app.post('/api/projects/:id/deploy/preflight', async (req, res) => {
    try {
      const { fileName, providerId = VERCEL_PROVIDER_ID } = req.body || {};
      if (providerId !== VERCEL_PROVIDER_ID) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'unsupported deploy provider');
      }
      if (typeof fileName !== 'string' || !fileName.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'fileName required');
      }
      /** @type {import('@open-design/contracts').DeployPreflightResponse} */
      const body = await prepareDeployPreflight(PROJECTS_DIR, req.params.id, fileName);
      res.json(body);
    } catch (err) {
      // DeployError is a known/expected outcome (validation, missing file).
      // Anything else points at a bug or an unexpected runtime state, so
      // surface it in the daemon log without leaking internals to the
      // client which still gets a generic 400.
      if (!(err instanceof DeployError)) {
        console.error('[deploy/preflight]', err);
      }
      const status = err instanceof DeployError ? err.status : 400;
      sendApiError(res, status, status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.post('/api/projects/:id/deployments/:deploymentId/check-link', async (req, res) => {
    try {
      const existing = getDeploymentById(db, req.params.id, req.params.deploymentId);
      if (!existing) {
        return sendApiError(res, 404, 'FILE_NOT_FOUND', 'deployment not found');
      }
      const result = await checkDeploymentUrl(existing.url);
      const now = Date.now();
      /** @type {import('@open-design/contracts').CheckDeploymentLinkResponse} */
      const body = upsertDeployment(db, {
        ...existing,
        status: result.reachable ? 'ready' : (result.status || 'link-delayed'),
        statusMessage: result.reachable
          ? 'Public link is ready.'
          : (result.statusMessage || 'Vercel is still preparing the public link.'),
        reachableAt: result.reachable ? now : existing.reachableAt,
        updatedAt: now,
      });
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  // Shared device frames (iPhone, Android, iPad, MacBook, browser chrome).
  // Skills can compose multi-screen / multi-device layouts by pointing at
  // these files via `<iframe src="/frames/iphone-15-pro.html?screen=...">`.
  // No mtime-based caching — frames are static and small.
  app.use('/frames', express.static(FRAMES_DIR));

  // Project files. Each project owns a flat folder under .od/projects/<id>/
  // containing every file the user has uploaded, pasted, sketched, or that
  // the agent has generated. Names are sanitized; paths are confined to the
  // project's own folder (see apps/daemon/src/projects.ts).
  app.get('/api/projects/:id/files', async (req, res) => {
    try {
      const files = await listFiles(PROJECTS_DIR, req.params.id);
      /** @type {import('@open-design/contracts').ProjectFilesResponse} */
      const body = { files };
      res.json(body);
    } catch (err) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  // Preflight for the raw file route. Current artifact fetches are simple GETs
  // (no preflight needed), but an explicit handler future-proofs the route if
  // artifacts ever add custom request headers.
  app.options('/api/projects/:id/raw/*', (req, res) => {
    if (req.headers.origin === 'null') {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.sendStatus(204);
  });

  app.get('/api/projects/:id/raw/*', async (req, res) => {
    try {
      const relPath = req.params[0];
      const file = await readProjectFile(PROJECTS_DIR, req.params.id, relPath);
      // PreviewModal loads artifact HTML via srcdoc, giving the iframe Origin: "null".
      // data: URIs, file://, and some sandboxed iframes also send null — all are
      // local-only callers, so this is safe. Real cross-origin sites send a real
      // origin and remain blocked by the browser's same-origin policy.
      if (req.headers.origin === 'null') {
        res.header('Access-Control-Allow-Origin', '*');
      }
      res.type(file.mime).send(file.buffer);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(res, status, status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST', String(err));
    }
  });

  app.delete('/api/projects/:id/raw/*', async (req, res) => {
    try {
      await deleteProjectFile(PROJECTS_DIR, req.params.id, req.params[0]);
      /** @type {import('@open-design/contracts').DeleteProjectFileResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(res, status, status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST', String(err));
    }
  });

  app.get('/api/projects/:id/files/:name/preview', async (req, res) => {
    try {
      const file = await readProjectFile(PROJECTS_DIR, req.params.id, req.params.name);
      const preview = await buildDocumentPreview(file);
      res.json(preview);
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(res, status, status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST', err?.message || 'preview unavailable');
    }
  });

  app.get('/api/projects/:id/files/:name', async (req, res) => {
    try {
      const file = await readProjectFile(PROJECTS_DIR, req.params.id, req.params.name);
      res.type(file.mime).send(file.buffer);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(res, status, status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST', String(err));
    }
  });

  // Two ways to upload: multipart for binary files (images), and JSON
  // {name, content, encoding} for sketches and pasted text. The frontend
  // uses both depending on the file source.
  app.post(
    '/api/projects/:id/files',
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (err) return sendMulterError(res, err);
        next();
      });
    },
    async (req, res) => {
      try {
        await ensureProject(PROJECTS_DIR, req.params.id);
        if (req.file) {
          const buf = await fs.promises.readFile(req.file.path);
          const desiredName = sanitizeName(req.body?.name || req.file.originalname);
          const meta = await writeProjectFile(
            PROJECTS_DIR,
            req.params.id,
            desiredName,
            buf,
          );
          fs.promises.unlink(req.file.path).catch(() => {});
          /** @type {import('@open-design/contracts').ProjectFileResponse} */
          const body = { file: meta };
          return res.json(body);
        }
        const { name, content, encoding, artifactManifest } = req.body || {};
        if (typeof name !== 'string' || typeof content !== 'string') {
          return sendApiError(res, 400, 'BAD_REQUEST', 'name and content required');
        }
        if (artifactManifest !== undefined && artifactManifest !== null) {
          const validated = validateArtifactManifestInput(artifactManifest, name);
          if (!validated.ok) {
            return sendApiError(res, 400, 'BAD_REQUEST', `invalid artifactManifest: ${validated.error}`);
          }
        }
        const buf =
          encoding === 'base64'
            ? Buffer.from(content, 'base64')
            : Buffer.from(content, 'utf8');
        const meta = await writeProjectFile(PROJECTS_DIR, req.params.id, name, buf, {
          artifactManifest,
        });
        /** @type {import('@open-design/contracts').ProjectFileResponse} */
        const body = { file: meta };
        res.json(body);
      } catch (err) {
        sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
      }
    },
  );

  app.delete('/api/projects/:id/files/:name', async (req, res) => {
    try {
      await deleteProjectFile(PROJECTS_DIR, req.params.id, req.params.name);
      /** @type {import('@open-design/contracts').DeleteProjectFileResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(res, status, status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST', String(err));
    }
  });

  app.get('/api/media/models', (_req, res) => {
    res.json({
      providers: MEDIA_PROVIDERS,
      image: IMAGE_MODELS,
      video: VIDEO_MODELS,
      audio: AUDIO_MODELS_BY_KIND,
      aspects: MEDIA_ASPECTS,
      videoLengthsSec: VIDEO_LENGTHS_SEC,
      audioDurationsSec: AUDIO_DURATIONS_SEC,
    });
  });

  app.get('/api/media/config', async (_req, res) => {
    try {
      const cfg = await readMaskedConfig(PROJECT_ROOT);
      res.json(cfg);
    } catch (err) {
      res.status(500).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.put('/api/media/config', async (req, res) => {
    try {
      const cfg = await writeConfig(PROJECT_ROOT, req.body);
      res.json(cfg);
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      res.status(status).json({ error: String(err && err.message ? err.message : err) });
    }
  });

  app.post('/api/projects/:id/media/generate', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({
        error: 'cross-origin request rejected: media generation is restricted to the local UI / CLI',
      });
    }

    try {
      const projectId = req.params.id;
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json({ error: 'project not found' });

      const taskId = randomUUID();
      const task = createMediaTask(taskId, projectId, {
        surface: req.body?.surface,
        model: req.body?.model,
      });
      console.error(
        `[task ${taskId.slice(0, 8)}] queued model=${req.body?.model} ` +
          `surface=${req.body?.surface} ` +
          `image=${req.body?.image ? 'yes' : 'no'} ` +
          `compositionDir=${req.body?.compositionDir ? 'yes' : 'no'}`,
      );

      task.status = 'running';
      generateMedia({
        projectRoot: PROJECT_ROOT,
        projectsRoot: PROJECTS_DIR,
        projectId,
        surface: req.body?.surface,
        model: req.body?.model,
        prompt: req.body?.prompt,
        output: req.body?.output,
        aspect: req.body?.aspect,
        length: typeof req.body?.length === 'number' ? req.body.length : undefined,
        duration:
          typeof req.body?.duration === 'number' ? req.body.duration : undefined,
        voice: req.body?.voice,
        audioKind: req.body?.audioKind,
        compositionDir: req.body?.compositionDir,
        image: req.body?.image,
        onProgress: (line) => appendTaskProgress(task, line),
      })
        .then((meta) => {
          task.status = 'done';
          task.file = meta;
          task.endedAt = Date.now();
          notifyTaskWaiters(task);
          console.error(
            `[task ${taskId.slice(0, 8)}] done size=${meta?.size} mime=${meta?.mime} ` +
              `elapsed=${Math.round((task.endedAt - task.startedAt) / 1000)}s`,
          );
        })
        .catch((err) => {
          task.status = 'failed';
          task.error = {
            message: String(err && err.message ? err.message : err),
            status: typeof err?.status === 'number' ? err.status : 400,
            code: err?.code,
          };
          task.endedAt = Date.now();
          notifyTaskWaiters(task);
          console.error(
            `[task ${taskId.slice(0, 8)}] failed status=${task.error.status} ` +
              `message=${(task.error.message || '').slice(0, 240)}`,
          );
        });

      res.status(202).json({
        taskId,
        status: task.status,
        startedAt: task.startedAt,
      });
    } catch (err) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      const code = err?.code;
      const body = { error: String(err && err.message ? err.message : err) };
      if (code) body.code = code;
      res.status(status).json(body);
    }
  });

  app.post('/api/media/tasks/:id/wait', async (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const taskId = req.params.id;
    const task = mediaTasks.get(taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });

    const since = Number.isFinite(req.body?.since) ? Number(req.body.since) : 0;
    const requestedTimeout = Number.isFinite(req.body?.timeoutMs)
      ? Number(req.body.timeoutMs)
      : 25_000;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 0), 25_000);

    const respond = () => {
      if (res.writableEnded) return;
      const snapshot = {
        taskId,
        status: task.status,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        progress: task.progress.slice(since),
        nextSince: task.progress.length,
      };
      if (task.status === 'done') snapshot.file = task.file;
      if (task.status === 'failed') snapshot.error = task.error;
      res.json(snapshot);
    };

    if (
      task.status === 'done' ||
      task.status === 'failed' ||
      task.progress.length > since
    ) {
      return respond();
    }

    let resolved = false;
    const wake = () => {
      if (resolved) return;
      resolved = true;
      task.waiters.delete(wake);
      clearTimeout(timer);
      respond();
    };
    task.waiters.add(wake);
    const timer = setTimeout(wake, timeoutMs);
    res.on('close', wake);
  });

  app.get('/api/projects/:id/media/tasks', (req, res) => {
    if (!isLocalSameOrigin(req, resolvedPort)) {
      return res.status(403).json({ error: 'cross-origin request rejected' });
    }
    const projectId = req.params.id;
    const includeDone =
      req.query.includeDone === '1' || req.query.includeDone === 'true';
    const tasks = [];
    for (const t of mediaTasks.values()) {
      if (t.projectId !== projectId) continue;
      const isTerminal = t.status === 'done' || t.status === 'failed';
      if (isTerminal && !includeDone) continue;
      tasks.push({
        taskId: t.id,
        status: t.status,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        elapsed: Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000),
        surface: t.surface,
        model: t.model,
        progress: t.progress.slice(-3),
        progressCount: t.progress.length,
        ...(t.status === 'done' ? { file: t.file } : {}),
        ...(t.status === 'failed' ? { error: t.error } : {}),
      });
    }
    tasks.sort((a, b) => b.startedAt - a.startedAt);
    res.json({ tasks });
  });

  // Multi-file upload that the chat composer uses for paste/drop/picker.
  // Files land flat in the project folder; the response carries the same
  // metadata as listFiles so the client can stage them as ChatAttachments
  // without a separate refetch.
  app.post(
    '/api/projects/:id/upload',
    handleProjectUpload,
    async (req, res) => {
      try {
        const incoming = Array.isArray(req.files) ? req.files : [];
        const out = [];
        for (const f of incoming) {
          try {
            const stat = await fs.promises.stat(f.path);
            out.push({
              name: f.filename,
              path: f.filename,
              size: stat.size,
              mtime: stat.mtimeMs,
              originalName: f.originalname,
            });
          } catch {
            // skip files that vanished mid-flight
          }
        }
        /** @type {import('@open-design/contracts').UploadProjectFilesResponse} */
        const body = { files: out };
        res.json(body);
      } catch (err) {
        sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
      }
    },
  );

  const design = {
    runs: createChatRunService({ createSseResponse, createSseErrorPayload }),
  };

  const composeDaemonSystemPrompt = async ({ projectId, skillId, designSystemId, conversationId }) => {
    const project = typeof projectId === 'string' && projectId ? getProject(db, projectId) : null;
    const effectiveSkillId = typeof skillId === 'string' && skillId ? skillId : project?.skillId;
    const effectiveDesignSystemId = typeof designSystemId === 'string' && designSystemId ? designSystemId : project?.designSystemId;
    const metadata = project?.metadata;

    let skillBody;
    let skillName;
    let skillMode;
    let skillCraftRequires = [];
    if (effectiveSkillId) {
      const skill = (await listSkills(SKILLS_DIR)).find((s) => s.id === effectiveSkillId);
      if (skill) {
        skillBody = skill.body;
        skillName = skill.name;
        skillMode = skill.mode;
        if (Array.isArray(skill.craftRequires)) skillCraftRequires = skill.craftRequires;
      }
    }

    let craftBody;
    let craftSections;
    if (skillCraftRequires.length > 0) {
      const loaded = await loadCraftSections(CRAFT_DIR, skillCraftRequires);
      if (loaded.body) {
        craftBody = loaded.body;
        craftSections = loaded.sections;
      }
    }

    let designSystemBody;
    let designSystemTitle;
    if (effectiveDesignSystemId) {
      const systems = await listDesignSystems(DESIGN_SYSTEMS_DIR);
      const summary = systems.find((s) => s.id === effectiveDesignSystemId);
      designSystemTitle = summary?.title;
      designSystemBody = await readDesignSystem(DESIGN_SYSTEMS_DIR, effectiveDesignSystemId) ?? undefined;
    }

    const template = metadata?.kind === 'template' && typeof metadata.templateId === 'string'
      ? getTemplate(db, metadata.templateId) ?? undefined
      : undefined;

    // Project references (T2.1). Surfaced as "User-curated references"
    // in the system prompt so the agent treats starred design systems
    // / screenshots / URLs / Figma nodes as taste signals. We only
    // fetch when a project exists (Topology C / no-project chats have
    // no per-project references to inject).
    const references = project ? listProjectReferences(db, project.id) : undefined;

    // Taste memory (T2.2). Three independent aggregations injected as
    // "Learned user preferences (may be wrong)" — see Layer 6 in
    // docs/prompt-engineering.md. User-level lives across projects;
    // project-level scopes; session-level captures recent flux.
    const tasteUserLevel = aggregateUserTaste(db);
    const tasteProjectLevel = project ? aggregateProjectTaste(db, project.id) : undefined;
    // Session id is the conversation id when one is bound to the run;
    // pure ad-hoc chats with no conversation id skip session-level.
    const sessionIdForTaste = typeof conversationId === 'string' && conversationId ? conversationId : null;
    const tasteSessionLevel = sessionIdForTaste ? aggregateSessionTaste(db, sessionIdForTaste) : undefined;

    return composeSystemPrompt({
      skillBody,
      skillName,
      skillMode,
      designSystemBody,
      designSystemTitle,
      craftBody,
      craftSections,
      metadata,
      template,
      references,
      tasteUserLevel: tasteUserLevel.length > 0 ? tasteUserLevel : undefined,
      tasteProjectLevel: tasteProjectLevel && tasteProjectLevel.length > 0 ? tasteProjectLevel : undefined,
      tasteSessionLevel: tasteSessionLevel && tasteSessionLevel.length > 0 ? tasteSessionLevel : undefined,
    });
  };

  const startChatRun = async (chatBody, run) => {
    /** @type {Partial<ChatRequest> & { imagePaths?: string[] }} */
    chatBody = chatBody || {};
    const {
      agentId,
      message,
      systemPrompt,
      imagePaths = [],
      projectId,
      conversationId,
      assistantMessageId,
      clientRequestId,
      skillId,
      designSystemId,
      attachments = [],
      commentAttachments = [],
      model,
      reasoning,
    } = chatBody;
    if (typeof projectId === 'string' && projectId) run.projectId = projectId;
    if (typeof conversationId === 'string' && conversationId) run.conversationId = conversationId;
    if (typeof assistantMessageId === 'string' && assistantMessageId) run.assistantMessageId = assistantMessageId;
    if (typeof clientRequestId === 'string' && clientRequestId) run.clientRequestId = clientRequestId;
    if (typeof agentId === 'string' && agentId) run.agentId = agentId;
    const def = getAgentDef(agentId);
    if (!def) return design.runs.fail(run, 'AGENT_UNAVAILABLE', `unknown agent: ${agentId}`);
    if (!def.bin) return design.runs.fail(run, 'AGENT_UNAVAILABLE', 'agent has no binary');
    const safeCommentAttachments = normalizeCommentAttachments(commentAttachments);
    if (
      (typeof message !== 'string' || !message.trim()) &&
      safeCommentAttachments.length === 0
    ) {
      return design.runs.fail(run, 'BAD_REQUEST', 'message required');
    }
    if (run.cancelRequested || design.runs.isTerminal(run.status)) return;

    // Resolve the project working directory (creating the folder if it
    // doesn't exist yet). Without one we don't pass cwd to spawn — the
    // agent then runs in whatever inherited dir, which still lets API
    // mode work but loses file-tool addressability.
    let cwd = null;
    let existingProjectFiles = [];
    if (typeof projectId === 'string' && projectId) {
      try {
        cwd = await ensureProject(PROJECTS_DIR, projectId);
        existingProjectFiles = await listFiles(PROJECTS_DIR, projectId);
      } catch {
        cwd = null;
      }
    }
    if (run.cancelRequested || design.runs.isTerminal(run.status)) return;

    // Sanitise supplied image paths: must live under UPLOAD_DIR.
    const safeImages = imagePaths.filter((p) => {
      const resolved = path.resolve(p);
      return resolved.startsWith(UPLOAD_DIR + path.sep) && fs.existsSync(resolved);
    });

    // Project-scoped attachments: project-relative paths inside cwd. Each
    // is run through the same path-traversal guard the file CRUD endpoints
    // use, then existence-checked. Whatever survives shows up as an
    // explicit list at the bottom of the user message so the agent knows
    // to Read it.
    const safeAttachments = cwd
      ? (Array.isArray(attachments) ? attachments : [])
        .filter((p) => typeof p === 'string' && p.length > 0)
        .filter((p) => {
          try {
            const abs = path.resolve(cwd, p);
            return (
              (abs === cwd || abs.startsWith(cwd + path.sep)) &&
              fs.existsSync(abs)
            );
          } catch {
            return false;
          }
        })
      : [];

    // Local code agents don't accept a separate "system" channel the way the
    // Messages API does — we fold the skill + design-system prompt into the
    // user message. The <artifact> wrapping instruction comes from
    // systemPrompt. We also stitch in the cwd hint so the agent knows
    // where its file tools should write, and the attachment list so it
    // doesn't have to guess what the user just dropped in.
    // Also ship the current file listing so the agent can pick a unique
    // filename instead of clobbering a previous artifact.
    const filesListBlock = existingProjectFiles.length
      ? `\nFiles already in this folder (do NOT overwrite unless the user asks; pick a fresh, descriptive name for new artifacts):\n${existingProjectFiles
          .map((f) => `- ${f.name}`)
          .join('\n')}`
      : '\nThis folder is empty. Choose a clear, descriptive filename for whatever you create.';
    const cwdHint = cwd
      ? `\n\nYour working directory: ${cwd}\nWrite project files relative to it (e.g. \`index.html\`, \`assets/x.png\`). The user can browse those files in real time.${filesListBlock}`
      : '';
    const attachmentHint = safeAttachments.length
      ? `\n\nAttached project files: ${safeAttachments.map((p) => `\`${p}\``).join(', ')}`
      : '';
    const commentHint = renderCommentAttachmentHint(safeCommentAttachments);
    const daemonSystemPrompt = await composeDaemonSystemPrompt({ projectId, skillId, designSystemId, conversationId });
    const instructionPrompt = [daemonSystemPrompt, systemPrompt]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join('\n\n---\n\n');
    const composed = [
      instructionPrompt
        ? `# Instructions (read first)\n\n${instructionPrompt}${cwdHint}\n\n---\n`
        : cwdHint
          ? `# Instructions${cwdHint}\n\n---\n`
          : '',
      `# User request\n\n${message || '(No extra typed instruction.)'}${attachmentHint}${commentHint}`,
      safeImages.length ? `\n\n${safeImages.map((p) => `@${p}`).join(' ')}` : '',
    ].join('');

    // Skill seeds (`skills/<id>/assets/template.html`) and design-system
    // specs (`design-systems/<id>/DESIGN.md`) live outside the project cwd.
    // The composed system prompt asks the agent to Read them via absolute
    // paths in the skill-root preamble — without an explicit allowlist,
    // Claude Code blocks those reads (issue #6: "no permission to read
    // skills template"). We surface both roots so any agent that honours
    // `--add-dir` can resolve those side files.
    const extraAllowedDirs = [SKILLS_DIR, DESIGN_SYSTEMS_DIR].filter(
      (d) => fs.existsSync(d),
    );
    // Per-agent model + reasoning the user picked in the model menu.
    // Trust the value when it matches the most recent /api/agents listing
    // (live or fallback). Otherwise allow it through if it passes a
    // permissive sanitizer — that's the path for user-typed custom model
    // ids the CLI's listing didn't surface yet.
    const safeModel =
      typeof model === 'string'
        ? isKnownModel(def, model)
          ? model
          : sanitizeCustomModel(model)
        : null;
    const safeReasoning =
      typeof reasoning === 'string' && Array.isArray(def.reasoningOptions)
        ? def.reasoningOptions.find((r) => r.id === reasoning)?.id ?? null
        : null;
    const agentOptions = { model: safeModel, reasoning: safeReasoning };

    const resolvedBin = resolveAgentBin(agentId);

    // If detection can't find the binary, surface a friendly SSE error
    // pointing at /api/agents instead of silently falling back to
    // spawn(def.bin) — that fallback re-introduces the exact ENOENT symptom
    // from issue #10.
    if (!resolvedBin) {
      design.runs.emit(run, 'error', createSseErrorPayload(
        'AGENT_UNAVAILABLE',
        `Agent "${def.name}" (\`${def.bin}\`) is not installed or not on PATH. ` +
          'Install it and refresh the agent list (GET /api/agents) before retrying.',
        { retryable: true },
      ));
      return design.runs.finish(run, 'failed', 1, null);
    }

    const args = def.buildArgs(composed, safeImages, extraAllowedDirs, agentOptions, { cwd });
    // Accumulate the agent's emitted text deltas and raw stdout so we
    // can scan for a `<od-critique>` block at end-of-turn. The visual
    // critique directive (when OD_VISUAL_CRITIQUE=1) makes the agent
    // emit this block after each artifact. Capping at 1 MiB keeps
    // memory bounded for long deck generations.
    let agentTextBuffer = '';
    const APPEND_TEXT_CAP = 1_000_000;
    const appendAgentText = (text) => {
      if (typeof text !== 'string' || text.length === 0) return;
      if (agentTextBuffer.length + text.length > APPEND_TEXT_CAP) {
        const room = Math.max(0, APPEND_TEXT_CAP - agentTextBuffer.length);
        agentTextBuffer += text.slice(0, room);
      } else {
        agentTextBuffer += text;
      }
    };

    // Wrap the SSE emit so usage events get a normalised cost AND so
    // we capture text deltas / stdout chunks for the post-run critique
    // parser. Claude Code already supplies `total_cost_usd`; other CLIs
    // (Copilot, Codex, Gemini) give token counts only. We compute USD
    // locally from the pricing table when costUsd is missing so the
    // UI shows a unified cost badge across every agent. See
    // specs/current/master-plan-2026-05.md T1.4.
    const send = (event, data) => {
      if (event === 'agent' && data && data.type === 'text_delta' && typeof data.delta === 'string') {
        appendAgentText(data.delta);
      } else if (event === 'stdout' && data && typeof data.chunk === 'string') {
        appendAgentText(data.chunk);
      } else if (event === 'agent' && data && data.type === 'raw' && typeof data.line === 'string') {
        appendAgentText(data.line);
      }
      if (event === 'agent' && data && data.type === 'usage') {
        const u = (data.usage ?? {}) as Record<string, number | undefined>;
        const haveCost =
          typeof data.costUsd === 'number' && Number.isFinite(data.costUsd);
        if (!haveCost) {
          const computed = computeCostUsd(safeModel, {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheReadTokens: u.cache_read_input_tokens,
            cacheWriteTokens: u.cache_creation_input_tokens,
          });
          if (computed !== null) {
            data = { ...data, costUsd: computed };
          }
        }
      }
      design.runs.emit(run, event, data);
    };

    // Capture run start time so the post-run linter can scope its scan to
    // files modified during this run only. Use Date.now() rather than
    // process.hrtime — we compare against fs stat mtimeMs which is wall
    // clock too. Subtract a small epsilon (250 ms) so a file written in
    // the same millisecond as our snapshot is not missed.
    const runStartedAtMs = Date.now() - 250;

    const odMediaEnv = {
      OD_BIN,
      OD_DAEMON_URL: `http://127.0.0.1:${resolvedPort}`,
      ...(typeof projectId === 'string' && projectId && cwd
        ? {
            OD_PROJECT_ID: projectId,
            OD_PROJECT_DIR: cwd,
          }
        : {}),
    };

    if (run.cancelRequested || design.runs.isTerminal(run.status)) return;

    run.status = 'running';
    run.updatedAt = Date.now();
    send('start', {
      runId: run.id,
      agentId,
      bin: resolvedBin,
      streamFormat: def.streamFormat ?? 'plain',
      projectId: typeof projectId === 'string' ? projectId : null,
      cwd,
      model: safeModel,
      reasoning: safeReasoning,
    });

    let child;
    let acpSession = null;
    try {
      // Prompt delivery via stdin is now the universal default. This bypasses
      // both the cmd.exe 8KB limit and the CreateProcess 32KB limit.
      const stdinMode = def.promptViaStdin || def.streamFormat === 'acp-json-rpc' ? 'pipe' : 'ignore';
      const env = { ...process.env, ...odMediaEnv };
      const invocation = createCommandInvocation({
        command: resolvedBin,
        args,
        env,
      });
      child = spawn(invocation.command, invocation.args, {
        env,
        stdio: [stdinMode, 'pipe', 'pipe'],
        cwd: cwd || undefined,
        shell: false,
      });
      run.child = child;
      if (def.promptViaStdin && child.stdin && def.streamFormat !== 'pi-rpc') {
        // EPIPE from a fast-exiting CLI (bad auth, missing model, exit on
        // launch) would otherwise surface as an unhandled stream error and
        // crash the daemon. Swallow it — the regular exit/close handlers
        // below already route the underlying failure to SSE via stderr.
        child.stdin.on('error', (err) => {
          if (err.code !== 'EPIPE') {
            send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', `stdin: ${err.message}`));
          }
        });
        child.stdin.end(composed, 'utf8');
      }
    } catch (err) {
      design.runs.emit(run, 'error', createSseErrorPayload('AGENT_EXECUTION_FAILED', `spawn failed: ${err.message}`));
      return design.runs.finish(run, 'failed', 1, null);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // Structured streams (Claude Code) go through a line-delimited JSON
    // parser that turns stream_event objects into UI-friendly events. For
    // plain streams (most other CLIs) we forward raw chunks unchanged so
    // the browser can append them to the assistant's text buffer.
    if (def.streamFormat === 'claude-stream-json') {
      const claude = createClaudeStreamHandler((ev) => send('agent', ev));
      child.stdout.on('data', (chunk) => claude.feed(chunk));
      child.on('close', () => claude.flush());
    } else if (def.streamFormat === 'copilot-stream-json') {
      const copilot = createCopilotStreamHandler((ev) => send('agent', ev));
      child.stdout.on('data', (chunk) => copilot.feed(chunk));
      child.on('close', () => copilot.flush());
    } else if (def.streamFormat === 'pi-rpc') {
      acpSession = attachPiRpcSession({
        child,
        prompt: composed,
        cwd: cwd || PROJECT_ROOT,
        model: safeModel,
        send,
      });
    } else if (def.streamFormat === 'acp-json-rpc') {
      acpSession = attachAcpSession({
        child,
        prompt: composed,
        cwd: cwd || PROJECT_ROOT,
        model: safeModel,
        send,
      });
    } else if (def.streamFormat === 'json-event-stream') {
      const handler = createJsonEventStreamHandler(def.eventParser || def.id, (ev) =>
        send('agent', ev),
      );
      child.stdout.on('data', (chunk) => handler.feed(chunk));
      child.on('close', () => handler.flush());
    } else {
      child.stdout.on('data', (chunk) => send('stdout', { chunk }));
    }
    child.stderr.on('data', (chunk) => send('stderr', { chunk }));

    child.on('error', (err) => {
      send('error', createSseErrorPayload('AGENT_EXECUTION_FAILED', err.message));
      design.runs.finish(run, 'failed', 1, null);
    });
    child.on('close', (code, signal) => {
      if (acpSession?.hasFatalError()) {
        return design.runs.finish(run, 'failed', code ?? 1, signal ?? null);
      }
      const status = run.cancelRequested
        ? 'canceled'
        : code === 0
          ? 'succeeded'
          : 'failed';

      // Visual critique hook. When OD_VISUAL_CRITIQUE is on, the agent
      // emits a `<od-critique>` block after each artifact; we extract
      // the LAST one (the verdict the agent landed on) from the captured
      // text buffer and surface it as a typed SSE event. The chat shell
      // renders findings the same way it renders the deterministic
      // linter output; the auto-revise button can pull from either
      // source. Failure is silent — critique is advisory.
      if (status === 'succeeded') {
        try {
          const critique = findFinalCritique(agentTextBuffer);
          if (critique) {
            send('critique-result', {
              runId: run.id,
              verdict: critique.verdict,
              reasoning: critique.reasoning,
              findings: critique.findings,
              totals: {
                p0: critique.findings.filter((f) => f.severity === 'P0').length,
                p1: critique.findings.filter((f) => f.severity === 'P1').length,
                p2: critique.findings.filter((f) => f.severity === 'P2').length,
              },
              ...(critique.scores ? { scores: critique.scores } : {}),
            });
          }
        } catch {
          // Critique parsing must never fail the run.
        }

        // Multi-shot judge hook. When OD_MULTI_SHOT is on, the agent
        // produces K variants and emits a `<od-judge>` ranking. The
        // chat shell uses the verdict to highlight the winner and
        // expose the others through a variant picker. Like critique,
        // failure is silent.
        try {
          const judge = findFinalJudge(agentTextBuffer);
          if (judge) {
            send('judge-result', {
              runId: run.id,
              winner: judge.winner,
              axis: judge.axis,
              ranking: judge.ranking,
              rationale: judge.rationale,
              confidence: judge.confidence,
            });
            // Taste-memory hook. When the judge picked with non-low
            // confidence, the chosen axis is a positive signal at the
            // user level — "this user thinks layout (or type, color,
            // density) is the dimension that matters." Low confidence
            // is recorded but at lower weight via polarity=1 + count.
            if (judge.axis) {
              try {
                recordTasteSignal(db, {
                  scope: 'user',
                  subject: `judge-axis:${judge.axis}`,
                  polarity: 1,
                  source: 'judge',
                  payload: { confidence: judge.confidence, runId: run.id },
                });
              } catch {
                // Memory recording must never fail the run.
              }
            }
          }
        } catch {
          // Judge parsing must never fail the run.
        }
      }

      // Post-run lint hook. Only fires for successful runs with a project
      // cwd (Topology C / no-project chats have no filesystem to scan).
      // Findings are emitted as a typed SSE event so the chat layer can
      // (a) render a P0 badge near the artifact and (b) offer a one-click
      // "Auto-revise" affordance that re-prompts with `agentMessage`.
      // We finish the run AFTER emitting so the event lands while the
      // SSE channel is still open.
      const finalize = () => design.runs.finish(run, status, code, signal);
      if (status === 'succeeded' && typeof cwd === 'string' && cwd.length > 0) {
        lintRunArtifacts(cwd, runStartedAtMs)
          .then((report) => {
            if (report.artifacts.length === 0) return;
            send('lint-result', {
              runId: run.id,
              artifacts: report.artifacts.map((a) => ({
                relPath: a.relPath,
                findings: a.findings,
              })),
              hasP0: report.hasP0,
              hasP1: report.hasP1,
              totals: {
                p0: report.totalP0,
                p1: report.totalP1,
                p2: report.totalP2,
              },
              agentMessage: report.agentMessage,
            });
            // Taste-memory hook. Each P0 lint rule that fired is a
            // negative signal at the project level — this project's
            // recurring slop tendency. Project-scoped (not user) so
            // a known-purple project doesn't poison every other
            // project's profile.
            if (typeof projectId === 'string' && projectId) {
              for (const a of report.artifacts) {
                for (const f of a.findings) {
                  if (f.severity !== 'P0') continue;
                  try {
                    recordTasteSignal(db, {
                      scope: 'project',
                      projectId,
                      subject: `slop-rule:${f.id}`,
                      polarity: -1,
                      source: 'lint',
                      payload: { runId: run.id, artifact: a.relPath },
                    });
                  } catch {
                    // Memory recording must never fail the run.
                  }
                }
              }
            }
          })
          .catch(() => {
            // Lint is advisory; never block run completion on a lint error.
          })
          .finally(finalize);
      } else {
        finalize();
      }
    });
  };

  app.post('/api/runs', (req, res) => {
    const run = design.runs.create(req.body || {});
    /** @type {import('@open-design/contracts').ChatRunCreateResponse} */
    const body = { runId: run.id };
    res.status(202).json(body);
    design.runs.start(run, () => startChatRun(req.body || {}, run));
  });

  app.get('/api/runs', (req, res) => {
    const { projectId, conversationId, status } = req.query;
    const runs = design.runs.list({ projectId, conversationId, status });
    /** @type {import('@open-design/contracts').ChatRunListResponse} */
    const body = { runs: runs.map(design.runs.statusBody) };
    res.json(body);
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    res.json(design.runs.statusBody(run));
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    design.runs.stream(run, req, res);
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = design.runs.get(req.params.id);
    if (!run) return sendApiError(res, 404, 'NOT_FOUND', 'run not found');
    design.runs.cancel(run);
    /** @type {import('@open-design/contracts').ChatRunCancelResponse} */
    const body = { ok: true };
    res.json(body);
  });

  app.post('/api/chat', (req, res) => {
    const run = design.runs.create();
    design.runs.stream(run, req, res);
    design.runs.start(run, () => startChatRun(req.body || {}, run));
  });

  // ---- API Proxy (SSE) for API-compatible endpoints ------------------------
  // Browser → daemon → external API. Avoids CORS issues with third-party
  // providers. This keeps BYOK setup zero-config for local users at the cost of
  // one local streaming hop through the daemon.

  const redactAuthTokens = (text) => text.replace(/Bearer [A-Za-z0-9_\-.+/=]+/g, 'Bearer [REDACTED]');

  const validateExternalApiBaseUrl = (baseUrl) => {
    let parsed;
    try {
      parsed = new URL(baseUrl.replace(/\/+$/, ''));
    } catch {
      return { error: 'Invalid baseUrl' };
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { error: 'Only http/https allowed' };
    }
    if (
      ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ||
      parsed.hostname.startsWith('169.254.') ||
      parsed.hostname.startsWith('10.') ||
      /^192\.168\./.test(parsed.hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname)
    ) {
      return { error: 'Internal IPs blocked', forbidden: true };
    }
    return { parsed };
  };

  app.post('/api/proxy/anthropic/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } = proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'baseUrl, apiKey, and model are required');
    }

    const validated = validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(res, validated.forbidden ? 403 : 400, validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST', validated.error);
    }

    const clean = baseUrl.replace(/\/+$/, '');
    const url = /\/v\d+$/.test(clean) ? `${clean}/messages` : `${clean}/v1/messages`;
    console.log(`[proxy:anthropic] ${req.method} ${validated.parsed.hostname} model=${model}`);

    const payload = {
      model,
      max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      messages: Array.isArray(messages) ? messages : [],
      stream: true,
    };
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payload.system = systemPrompt;
    }

    const sse = createSseResponse(res);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[proxy:anthropic] upstream error: ${response.status} ${redactAuthTokens(errorText)}`);
        sse.send('error', { message: `Upstream error: ${response.status}`, details: errorText });
        return sse.end();
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            const event = line.slice(7).trim();
            const dataLine = lines[lines.indexOf(line) + 1];
            if (dataLine && dataLine.startsWith('data: ')) {
              try {
                const data = JSON.parse(dataLine.slice(6));
                sse.send(event, data);
              } catch (e) {
                // ignore parse errors for partial chunks
              }
            }
          }
        }
      }
      sse.end();
    } catch (err) {
      console.error(`[proxy:anthropic] internal error: ${err.message}`);
      sse.send('error', { message: err.message });
      sse.end();
    }
  });

  app.post('/api/proxy/openai/stream', async (req, res) => {
    /** @type {Partial<ProxyStreamRequest>} */
    const proxyBody = req.body || {};
    const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } = proxyBody;
    if (!baseUrl || !apiKey || !model) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'baseUrl, apiKey, and model are required');
    }

    const validated = validateExternalApiBaseUrl(baseUrl);
    if (validated.error) {
      return sendApiError(res, validated.forbidden ? 403 : 400, validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST', validated.error);
    }

    const clean = baseUrl.replace(/\/+$/, '');
    const url = /\/v\d+$/.test(clean) ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
    console.log(`[proxy:openai] ${req.method} ${validated.parsed.hostname} model=${model}`);

    const payloadMessages = Array.isArray(messages) ? [...messages] : [];
    if (typeof systemPrompt === 'string' && systemPrompt) {
      payloadMessages.unshift({ role: 'system', content: systemPrompt });
    }

    const payload = {
      model,
      messages: payloadMessages,
      max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
      stream: true,
    };

    const sse = createSseResponse(res);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[proxy:openai] upstream error: ${response.status} ${redactAuthTokens(errorText)}`);
        sse.send('error', { message: `Upstream error: ${response.status}`, details: errorText });
        return sse.end();
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') break;
            try {
              const data = JSON.parse(dataStr);
              sse.send('message', data);
            } catch (e) {
              // ignore parse errors for partial chunks
            }
          }
        }
      }
      sse.end();
    } catch (err) {
      console.error(`[proxy:openai] internal error: ${err.message}`);
      sse.send('error', { message: err.message });
      sse.end();
    }
  });

  // Wait for `listen` to bind so callers always see the resolved URL —
  // critical when port=0 (ephemeral port) and when the embedding sidecar
  // needs to advertise the port to a parent process before any request
  // can flow. Three callers depend on this contract:
  //   - `apps/daemon/src/cli.ts`            → expects a `url` string
  //   - `apps/daemon/sidecar/server.ts`     → expects `{ url, server }`
  //   - `apps/daemon/tests/version-route.test.ts` → expects `{ url, server }`
  return await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      // `address()` can in theory return `string | AddressInfo | null`. For
      // a TCP listener it's always `AddressInfo` with a `.port` — the guard
      // is belt-and-braces so an unexpected null never silently produces a
      // `http://127.0.0.1:0` URL that callers would then try to fetch.
      const boundPort = address && typeof address === 'object' ? address.port : null;
      if (!boundPort) {
        reject(new Error(`[od] daemon failed to resolve listening port (address=${JSON.stringify(address)})`));
        return;
      }
      resolvedPort = boundPort;
      // When binding to all interfaces report localhost for local callers;
      // when binding to a specific address (e.g. a Tailscale IP) report that
      // address so remote callers and the sidecar use the correct URL.
      const reportHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      const url = `http://${reportHost}:${resolvedPort}`;
      if (!returnServer) {
        console.log(`[od] daemon listening on ${url}`);
      }
      resolve(returnServer ? { url, server } : url);
    });
    // `app.listen` throws synchronously when the port is already in use on
    // some Node versions, but emits an `error` event on others (and for
    // EACCES / EADDRNOTAVAIL even on the same Node). Wire the event so the
    // returned Promise always settles instead of hanging forever.
    server.on('error', reject);
  });
}

function randomId() {
  return randomUUID();
}

function sanitizeSlug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function assembleExample(templateHtml, slidesHtml, title) {
  return templateHtml
    .replace('<!-- SLIDES_HERE -->', slidesHtml)
    .replace(/<title>.*?<\/title>/, `<title>${title} | Open Design Example</title>`);
}

function isLocalSameOrigin(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true; // Direct non-browser calls are trusted
  try {
    const url = new URL(origin);
    return (
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      url.port === String(port)
    );
  } catch {
    return false;
  }
}
