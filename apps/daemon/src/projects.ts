// @ts-nocheck
// Project files registry. Each project is a folder under
// <projectRoot>/.od/projects/<projectId>/. The frontend's project list
// (localStorage) carries metadata; this module is the single owner of the
// on-disk content (HTML artifacts, sketches, uploaded images, pasted text).
//
// All paths flowing in from HTTP handlers are validated against the project
// directory to prevent path traversal — see resolveSafe().

import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  inferLegacyManifest,
  parsePersistedManifest,
  validateArtifactManifestInput,
} from './artifact-manifest.js';

const FORBIDDEN_SEGMENT = /^$|^\.\.?$/;

export function projectDir(projectsRoot, projectId) {
  if (!isSafeId(projectId)) throw new Error('invalid project id');
  return path.join(projectsRoot, projectId);
}

// Returns the folder a project's files live in. For git-linked projects
// (metadata.folderPath set), this is the user's own folder. Otherwise falls
// back to the standard computed path under projectsRoot.
export function resolveProjectDir(projectsRoot, projectId, metadata?) {
  if (typeof metadata?.folderPath === 'string') {
    const p = path.normalize(metadata.folderPath);
    if (path.isAbsolute(p)) return p;
  }
  if (!isSafeId(projectId)) throw new Error('invalid project id');
  return path.join(projectsRoot, projectId);
}

export async function ensureProject(projectsRoot, projectId, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  // Git-linked folders already exist; skip mkdir to avoid side-effects.
  if (typeof metadata?.folderPath !== 'string') {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export async function listFiles(projectsRoot, projectId, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const out = [];
  // Skip build/install dirs for linked folders so node_modules doesn't stall
  // the walk on large repos.
  const skipDirs = metadata?.folderPath ? SKIP_DIRS : undefined;
  await collectFiles(dir, '', out, skipDirs);
  // Newest first — matches the visual order users expect after generating.
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ---- Design-file collector for folder import --------------------------------

const DESIGN_EXTS = new Set([
  '.html', '.htm',
  '.css', '.scss', '.sass', '.less',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.svg',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.avif',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.md',
]);

// .json only when small (config files, token maps, etc.)
const JSON_MAX_BYTES = 100 * 1024;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.turbo',
  '.cache', '.output', 'out', 'coverage', '__pycache__', '.venv',
  'vendor', 'target', '.od', '.tmp',
]);

const FOLDER_MAX_FILES = 500;
const FOLDER_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const FOLDER_MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface DesignFile {
  relPath: string;
  fullPath: string;
  size: number;
}

export async function collectDesignFiles(rootDir: string): Promise<DesignFile[]> {
  const out: DesignFile[] = [];
  let totalBytes = 0;

  async function walk(dir: string, relDir: string) {
    if (out.length >= FOLDER_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= FOLDER_MAX_FILES) return;
      const name = e.name;
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(name)) await walk(full, rel);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      const isJson = ext === '.json';
      if (!DESIGN_EXTS.has(ext) && !isJson) continue;
      let size: number;
      try {
        const st = await stat(full);
        size = st.size;
      } catch {
        continue;
      }
      if (size > FOLDER_MAX_FILE_BYTES) continue;
      if (isJson && size > JSON_MAX_BYTES) continue;
      if (totalBytes + size > FOLDER_MAX_TOTAL_BYTES) continue;
      totalBytes += size;
      out.push({ relPath: rel, fullPath: full, size });
    }
  }

  await walk(rootDir, '');
  return out;
}

export async function detectEntryFile(dir: string): Promise<string | null> {
  try {
    await stat(path.join(dir, 'index.html'));
    return 'index.html';
  } catch { /* not found */ }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const htmlFile = entries.find((e) => e.isFile() && /\.html?$/i.test(e.name));
    if (htmlFile) return htmlFile.name;
  } catch { /* ignore */ }
  return null;
}

export function isGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

async function collectFiles(dir, relDir, out, skipDirs?: Set<string>) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipDirs && skipDirs.has(e.name)) continue;
      await collectFiles(full, rel, out, skipDirs);
      continue;
    }
    if (!e.isFile()) continue;
    if (e.name.endsWith('.artifact.json')) continue;
    const st = await stat(full);
    const manifest = await readManifestForPath(dir, rel);
    out.push({
      name: rel,
      path: rel,
      type: 'file',
      size: st.size,
      mtime: st.mtimeMs,
      kind: kindFor(rel),
      mime: mimeFor(rel),
      artifactKind: manifest?.kind,
      artifactManifest: manifest,
    });
  }
}

export async function readProjectFile(projectsRoot, projectId, name, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const file = resolveSafe(dir, name);
  const buf = await readFile(file);
  const st = await stat(file);
  const rel = toProjectPath(path.relative(dir, file));
  const manifest = await readManifestForPath(dir, rel);
  return {
    buffer: buf,
    name: rel,
    path: rel,
    size: st.size,
    mtime: st.mtimeMs,
    mime: mimeFor(rel),
    kind: kindFor(rel),
    artifactKind: manifest?.kind,
    artifactManifest: manifest,
  };
}

export async function writeProjectFile(
  projectsRoot,
  projectId,
  name,
  body,
  { overwrite = true, artifactManifest = null } = {},
  metadata?,
) {
  const dir = await ensureProject(projectsRoot, projectId, metadata);
  const safeName = sanitizePath(name);
  const target = resolveSafe(dir, safeName);
  if (!overwrite) {
    try {
      await stat(target);
      throw new Error('file already exists');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  if (artifactManifest && typeof artifactManifest === 'object') {
    const manifestFileName = artifactManifestNameFor(safeName);
    const manifestTarget = resolveSafe(dir, manifestFileName);
    const validated = validateArtifactManifestInput(artifactManifest, safeName);
    if (validated.ok && validated.value) {
      const nextManifest = validated.value;
      await writeFile(manifestTarget, JSON.stringify(nextManifest, null, 2));
    }
  }
  const st = await stat(target);
  const persistedManifest = await readManifestForPath(dir, safeName);
  return {
    name: safeName,
    path: safeName,
    size: st.size,
    mtime: st.mtimeMs,
    kind: kindFor(safeName),
    mime: mimeFor(safeName),
    artifactKind: persistedManifest?.kind,
    artifactManifest: persistedManifest,
  };
}

function artifactManifestNameFor(name) {
  return `${name}.artifact.json`;
}

async function readManifestForPath(projectDirPath, relPath) {
  const manifestPath = path.join(projectDirPath, artifactManifestNameFor(relPath));
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = parseManifest(raw);
    if (parsed) return parsed;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      // ignore malformed/invalid manifests and fallback to inference
    }
  }
  return inferLegacyManifest(relPath);
}

function parseManifest(raw) {
  return parsePersistedManifest(raw, '');
}

export async function deleteProjectFile(projectsRoot, projectId, name, metadata?) {
  const dir = resolveProjectDir(projectsRoot, projectId, metadata);
  const file = resolveSafe(dir, name);
  await unlink(file);
}

export async function removeProjectDir(projectsRoot, projectId) {
  const dir = projectDir(projectsRoot, projectId);
  await rm(dir, { recursive: true, force: true });
}

function resolveSafe(dir, name) {
  const safePath = validateProjectPath(name);
  const target = path.resolve(dir, safePath);
  if (!target.startsWith(dir + path.sep) && target !== dir) {
    throw new Error('path escapes project dir');
  }
  return target;
}

export function sanitizePath(raw) {
  const normalized = validateProjectPath(raw);
  return normalized.split('/').map(sanitizeName).join('/');
}

export function validateProjectPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('invalid file name');
  }
  if (raw.includes('\0') || /^[A-Za-z]:/.test(raw) || raw.startsWith('/')) {
    throw new Error('invalid file name');
  }
  const normalized = raw.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => FORBIDDEN_SEGMENT.test(p))) {
    throw new Error('invalid file name');
  }
  return parts.join('/');
}

// Keep Unicode letters/digits as-is; replace path separators, control
// characters, and reserved punctuation with underscore. Spaces collapse
// to dashes (matches the kebab-case style used by the agent's slugs).
// The previous ASCII-only filter collapsed every non-ASCII character to
// '_', so a Chinese filename like '测试文档.docx' became '____.docx'
// (issue #144).
export function sanitizeName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || `file-${Date.now()}`;
}

// multer@1 decodes multipart filenames as latin1, which mangles any
// UTF-8 bytes (Chinese, Japanese, Cyrillic, ...) the user uploads. Re-
// decode as UTF-8 when the result round-trips back to the original
// bytes; otherwise the source was genuine latin1 and we leave it alone.
export function decodeMultipartFilename(name) {
  if (!name || typeof name !== 'string') return name ?? '';
  // If any code point exceeds 0xFF the source is already a properly
  // decoded Unicode string — for example, multer received an RFC 5987
  // `filename*` parameter and decoded it as UTF-8. Re-running latin1
  // -> utf8 here would corrupt those names, so exit early.
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0xff) return name;
  }
  const buf = Buffer.from(name, 'latin1');
  const utf8 = buf.toString('utf8');
  return Buffer.from(utf8, 'utf8').equals(buf) ? utf8 : name;
}

function toProjectPath(raw) {
  return raw.split(path.sep).join('/');
}

function isSafeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(id);
}

const EXT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

export function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

// Coarse kind buckets the frontend uses to pick a viewer.
export function kindFor(name) {
  // Editable sketches use a compound extension so they slot into the
  // "sketch" bucket while still being valid JSON on disk.
  if (name.endsWith('.sketch.json')) return 'sketch';
  const ext = path.extname(name).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.svg') return 'sketch';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(ext)) {
    if (name.startsWith('sketch-')) return 'sketch';
    return 'image';
  }
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a'].includes(ext)) return 'audio';
  if (['.md', '.txt'].includes(ext)) return 'text';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.css', '.py'].includes(ext)) {
    return 'code';
  }
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'document';
  if (ext === '.pptx') return 'presentation';
  if (ext === '.xlsx') return 'spreadsheet';
  return 'binary';
}
