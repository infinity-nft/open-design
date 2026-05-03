// @ts-nocheck
/**
 * Post-run artifact linter. Runs after a chat agent finishes, finds the
 * HTML artifacts the run produced (by mtime, scoped to the project cwd),
 * lints each one, and assembles a single agent-ready feedback block.
 *
 * The intent is to close the lint→refine loop documented in
 * `docs/prompt-engineering.md` Layer 4: today the linter ships findings
 * as a P0/P1 badge in the UI; with this hook the same findings can be
 * fed back to the agent on the next turn so it can self-correct without
 * the user having to manually type the diagnosis.
 *
 * The hook only emits findings; it does not auto-spawn a revise turn.
 * That decision belongs to the chat layer (auto-revise toggle vs.
 * one-click "Auto-revise" button per docs/prompt-engineering.md Layer 4).
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { lintArtifact, renderFindingsForAgent } from './lint-artifact.js';

const HTML_EXTENSION_RE = /\.html?$/i;
// Skip large directories an agent never legitimately writes into; this
// keeps the post-run scan linear in artifact count rather than in
// repository size.
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  '.od', // generated output of OD itself
  '.tmp',
]);
const MAX_FILES_SCANNED = 200;
const MAX_BYTES_PER_FILE = 2 * 1024 * 1024; // 2 MB

export interface ArtifactLintResult {
  path: string;
  relPath: string;
  findings: ReturnType<typeof lintArtifact>;
}

export interface PostRunLintReport {
  artifacts: ArtifactLintResult[];
  hasP0: boolean;
  hasP1: boolean;
  totalP0: number;
  totalP1: number;
  totalP2: number;
  /**
   * One agent-ready feedback message that aggregates findings across all
   * touched artifacts. Empty string when there is nothing to say.
   */
  agentMessage: string;
}

/**
 * Walk `cwd`, find HTML artifacts modified after `since`, lint them.
 *
 * @param cwd     The project's working directory; usually the agent cwd.
 * @param since   Epoch ms; only files with mtime ≥ this are considered.
 */
export async function lintRunArtifacts(
  cwd: string,
  since: number,
): Promise<PostRunLintReport> {
  const candidates = await collectRecentHtmlFiles(cwd, since);
  const results: ArtifactLintResult[] = [];

  for (const filePath of candidates) {
    try {
      const stats = await stat(filePath);
      if (stats.size > MAX_BYTES_PER_FILE) continue;
      const html = await readFile(filePath, 'utf8');
      const findings = lintArtifact(html);
      if (findings.length === 0) continue;
      results.push({
        path: filePath,
        relPath: path.relative(cwd, filePath),
        findings,
      });
    } catch {
      // Files can disappear between the scan and the read; skip silently.
    }
  }

  return summarise(results);
}

async function collectRecentHtmlFiles(
  root: string,
  since: number,
): Promise<string[]> {
  const out: string[] = [];
  await walk(root, since, out);
  return out;
}

async function walk(
  dir: string,
  since: number,
  out: string[],
): Promise<void> {
  if (out.length >= MAX_FILES_SCANNED) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES_SCANNED) return;
    if (entry.name.startsWith('.') && entry.name !== '.') {
      // Hidden files are user state, not artifacts. Allow project-root
      // hidden directories named `.od/` to be skipped via the explicit
      // SKIP_DIRECTORIES list (handled below) so users can still place
      // intentional artifacts in non-hidden locations.
    }
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, since, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!HTML_EXTENSION_RE.test(entry.name)) continue;
    try {
      const stats = await stat(full);
      if (stats.mtimeMs < since) continue;
      out.push(full);
    } catch {
      continue;
    }
  }
}

function summarise(artifacts: ArtifactLintResult[]): PostRunLintReport {
  let totalP0 = 0;
  let totalP1 = 0;
  let totalP2 = 0;
  for (const a of artifacts) {
    for (const f of a.findings) {
      if (f.severity === 'P0') totalP0 += 1;
      else if (f.severity === 'P1') totalP1 += 1;
      else if (f.severity === 'P2') totalP2 += 1;
    }
  }

  let agentMessage = '';
  if (artifacts.length > 0 && totalP0 + totalP1 > 0) {
    const blocks: string[] = [];
    blocks.push(
      '<artifact-lint-summary>',
      `Run produced ${artifacts.length} artifact(s) with ${totalP0} P0 (must fix), ${totalP1} P1 (should fix), ${totalP2} P2 findings.`,
      'When you regenerate, fix the P0 issues first; do not rebuild the page wholesale — change only the affected sections.',
      '',
    );
    for (const a of artifacts) {
      const formatted = renderFindingsForAgent(a.findings);
      if (formatted) {
        blocks.push(`### ${a.relPath}`, '', formatted, '');
      }
    }
    blocks.push('</artifact-lint-summary>');
    agentMessage = blocks.join('\n');
  }

  return {
    artifacts,
    hasP0: totalP0 > 0,
    hasP1: totalP1 > 0,
    totalP0,
    totalP1,
    totalP2,
    agentMessage,
  };
}
