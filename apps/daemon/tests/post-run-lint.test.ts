// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { lintRunArtifacts } from '../src/post-run-lint.js';

const SLOPPY_HTML = `<!doctype html>
<html><body>
  <style>.cta { background: #6366f1; color: white; }</style>
  <button class="cta">Get started</button>
</body></html>`;

const CLEAN_HTML = `<!doctype html>
<html><body>
  <style>.cta { background: var(--accent); color: white; }</style>
  <button class="cta">Get started</button>
</body></html>`;

describe('lintRunArtifacts', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'od-postlint-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds and lints HTML artifacts modified during the run', async () => {
    const since = Date.now() - 100;
    const file = path.join(dir, 'index.html');
    await writeFile(file, SLOPPY_HTML, 'utf8');

    const report = await lintRunArtifacts(dir, since);

    expect(report.artifacts).toHaveLength(1);
    expect(report.artifacts[0].relPath).toBe('index.html');
    expect(report.totalP0).toBeGreaterThan(0);
    expect(report.hasP0).toBe(true);
    expect(report.agentMessage).toContain('<artifact-lint-summary>');
    expect(report.agentMessage).toContain('index.html');
  });

  it('skips files older than the run start time', async () => {
    const file = path.join(dir, 'old.html');
    await writeFile(file, SLOPPY_HTML, 'utf8');
    // Backdate the file to before the run.
    const past = new Date(Date.now() - 60_000);
    await utimes(file, past, past);

    const since = Date.now() - 1000;
    const report = await lintRunArtifacts(dir, since);
    expect(report.artifacts).toHaveLength(0);
    expect(report.agentMessage).toBe('');
  });

  it('skips clean artifacts even when modified during the run', async () => {
    const since = Date.now() - 100;
    await writeFile(path.join(dir, 'clean.html'), CLEAN_HTML, 'utf8');

    const report = await lintRunArtifacts(dir, since);
    expect(report.artifacts).toHaveLength(0);
  });

  it('skips node_modules and .od and other generated dirs', async () => {
    const since = Date.now() - 100;
    await mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await writeFile(
      path.join(dir, 'node_modules', 'sloppy.html'),
      SLOPPY_HTML,
      'utf8',
    );
    await mkdir(path.join(dir, '.od'), { recursive: true });
    await writeFile(path.join(dir, '.od', 'sloppy.html'), SLOPPY_HTML, 'utf8');
    // Real artifact at root should still be found.
    await writeFile(path.join(dir, 'real.html'), SLOPPY_HTML, 'utf8');

    const report = await lintRunArtifacts(dir, since);
    expect(report.artifacts.map((a) => a.relPath)).toEqual(['real.html']);
  });

  it('returns empty report when there are no HTML files', async () => {
    const since = Date.now() - 100;
    await writeFile(path.join(dir, 'notes.txt'), 'plain text', 'utf8');
    const report = await lintRunArtifacts(dir, since);
    expect(report.artifacts).toHaveLength(0);
    expect(report.hasP0).toBe(false);
    expect(report.agentMessage).toBe('');
  });

  it('aggregates findings from multiple artifacts into one agent message', async () => {
    const since = Date.now() - 100;
    await writeFile(path.join(dir, 'a.html'), SLOPPY_HTML, 'utf8');
    await writeFile(path.join(dir, 'b.html'), SLOPPY_HTML, 'utf8');
    const report = await lintRunArtifacts(dir, since);
    expect(report.artifacts).toHaveLength(2);
    expect(report.agentMessage).toContain('a.html');
    expect(report.agentMessage).toContain('b.html');
    expect(report.agentMessage).toMatch(/Run produced 2 artifact/);
  });
});
