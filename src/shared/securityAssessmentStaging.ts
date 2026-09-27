/**
 * BE9.2 exact-source staging constants and fixed trusted helper program.
 * Caller input cannot alter these ceilings or the helper argv.
 */
export const BE9_SOURCE_MAX_FILES = 20_000;
export const BE9_SOURCE_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const BE9_SOURCE_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const BE9_SOURCE_MAX_PATH_BYTES = 4 * 1024;
export const BE9_SOURCE_MAX_PATH_DEPTH = 64;
export const BE9_SOURCE_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const BE9_SOURCE_MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
export const BE9_SOURCE_STAGING_POLICY_VERSION = 'BE9_SOURCE_STAGING_POLICY_V1' as const;

export const ASSESSMENT_STAGER_SCRIPT = String.raw`
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { TextDecoder } = require('util');

const SRC = '/src';
const DST = '/workspace';
const EXPECTED = process.env.EXPECTED_SOURCE_REVISION || '';
const EXPECTED_MANIFEST = process.env.EXPECTED_MANIFEST_DIGEST || '';
const MODE = process.env.ASSESSMENT_STAGE_MODE || 'stage';
const ASSESSMENT_ID = process.env.ASSESSMENT_ID || '';
const PROJECT_ID = process.env.PROJECT_ID || '';
const STAGER_IMAGE_ID = process.env.STAGER_IMAGE_ID || '';
const POLICY_VERSION = process.env.STAGING_POLICY_VERSION || '';
const MAX_FILES = 20000;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_PATH = 4 * 1024;
const MAX_DEPTH = 64;
const MAX_MANIFEST = 4 * 1024 * 1024;
const MAX_ARCHIVE = 160 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code, detail) {
  process.stderr.write(String(code) + (detail ? ':' + String(detail).slice(0, 512) : '') + '\n');
  process.exit(Number(code) || 70);
}
function runGit(args, maxBuffer = 4 * 1024 * 1024) {
  const r = spawnSync('git', ['-c', 'safe.directory=' + SRC, '-C', SRC, ...args], {
    encoding: null,
    maxBuffer,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', HOME: '/tmp' },
  });
  if (r.error || r.status !== 0) fail(20, (r.stderr || r.error?.message || 'git failed').toString());
  return Buffer.from(r.stdout || []);
}
function safePath(bytes) {
  if (bytes.length < 1 || bytes.length > MAX_PATH) fail(25, 'path bytes');
  let value;
  try { value = decoder.decode(bytes); } catch { fail(25, 'path utf8'); }
  if (value.startsWith('/') || value.includes('\0') || value.includes('\\')) fail(25, 'path shape');
  const parts = value.split('/');
  if (parts.length > MAX_DEPTH || parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) fail(25, 'path components');
  if (path.posix.normalize(value) !== value) fail(25, 'path canonical');
  return value;
}
function sha1Blob(buf) {
  return crypto.createHash('sha1').update(Buffer.from('blob ' + buf.length + '\0')).update(buf).digest('hex');
}
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function assertFileBounds(size, rel) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE) fail(28, 'file size:' + rel);
}

if (!/^[0-9a-f]{40}$/.test(EXPECTED)) fail(21, 'expected revision');
if (!/^assessment_[0-9a-f]{24}$/.test(ASSESSMENT_ID)) fail(21, 'assessment identity');
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(PROJECT_ID)) fail(21, 'project identity');
if (!/^sha256:[0-9a-f]{64}$/.test(STAGER_IMAGE_ID)) fail(21, 'stager image identity');
if (POLICY_VERSION !== 'BE9_SOURCE_STAGING_POLICY_V1') fail(21, 'staging policy version');
if (MODE !== 'stage' && MODE !== 'verify') fail(21, 'mode');
if (MODE === 'verify' && !/^[0-9a-f]{64}$/.test(EXPECTED_MANIFEST)) fail(21, 'expected manifest digest');
if (MODE === 'stage' && EXPECTED_MANIFEST !== '') fail(21, 'stage may not accept expected manifest');

const head = runGit(['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim();
if (head !== EXPECTED) fail(22, 'source revision drift');
const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
if (status.length !== 0) fail(23, 'dirty source');

const tree = runGit(['rev-parse', '--verify', EXPECTED + '^{tree}']).toString('utf8').trim();
if (!/^[0-9a-f]{40}$/.test(tree)) fail(24, 'tree identity');

const raw = runGit(['ls-tree', '-r', '-z', '-l', '--full-tree', EXPECTED], 32 * 1024 * 1024);
const records = [];
let cursor = 0;
while (cursor < raw.length) {
  const nul = raw.indexOf(0, cursor);
  if (nul < 0) fail(25, 'ls-tree terminator');
  if (nul > cursor) records.push(raw.subarray(cursor, nul));
  cursor = nul + 1;
}
const manifest = [];
const expectedPaths = new Set();
let total = 0;
for (const rec of records) {
  const tab = rec.indexOf(9);
  if (tab < 0) fail(25, 'ls-tree framing');
  const meta = rec.subarray(0, tab).toString('ascii').trim().split(/\s+/);
  if (meta.length !== 4) fail(25, 'ls-tree metadata');
  const [mode, type, oid, sizeText] = meta;
  const rel = safePath(rec.subarray(tab + 1));
  if (expectedPaths.has(rel)) fail(25, 'duplicate canonical path:' + rel);
  expectedPaths.add(rel);
  if (mode === '120000') fail(26, 'tracked symlink:' + rel);
  if (mode === '160000' || type !== 'blob') fail(27, 'unsupported tree entry:' + rel);
  if (!/^[0-9a-f]{40}$/.test(oid)) fail(25, 'object id');
  const size = Number(sizeText);
  assertFileBounds(size, rel);
  total += size;
  if (total > MAX_TOTAL) fail(28, 'total bytes');
  manifest.push({ path: rel, size, oid, mode });
  if (manifest.length > MAX_FILES) fail(28, 'file count');
}
manifest.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST) fail(28, 'manifest bytes');

if (MODE === 'stage') {
  if (fs.readdirSync(DST).length !== 0) fail(29, 'source volume not empty');
  const archive = runGit(['archive', '--format=tar', EXPECTED], MAX_ARCHIVE);
  if (archive.length > MAX_ARCHIVE) fail(28, 'archive bytes');

  for (let off = 0; off + 512 <= archive.length;) {
    const header = archive.subarray(off, off + 512);
    if (header.every(b => b === 0)) break;
    const type = String.fromCharCode(header[156] || 0);
    if (type === '1' || type === '2') fail(30, 'archive link entry');
    const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const bodySize = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    if (!Number.isFinite(bodySize) || bodySize < 0) fail(30, 'archive size');
    off += 512 + Math.ceil(bodySize / 512) * 512;
  }

  const tar = spawnSync('tar', ['-x', '-f', '-', '-C', DST], {
    input: archive,
    encoding: null,
    maxBuffer: 1024 * 1024,
  });
  if (tar.error || tar.status !== 0) fail(31, (tar.stderr || tar.error?.message || 'tar extraction').toString());
}

const actualPaths = new Set();
let actualTotal = 0;
function walk(dir, rel = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? rel + '/' + ent.name : ent.name;
    safePath(Buffer.from(childRel, 'utf8'));
    const full = path.join(dir, ent.name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) fail(32, 'unexpected staged symlink:' + childRel);
    if (st.isDirectory()) { walk(full, childRel); continue; }
    if (!st.isFile()) fail(32, 'unexpected staged type:' + childRel);
    if (st.nlink !== 1) fail(32, 'unexpected hardlink:' + childRel);
    if (!expectedPaths.has(childRel)) fail(32, 'unexpected staged file:' + childRel);
    if (actualPaths.has(childRel)) fail(32, 'duplicate staged file:' + childRel);
    assertFileBounds(st.size, childRel);
    actualPaths.add(childRel);
    actualTotal += st.size;
    if (actualPaths.size > MAX_FILES || actualTotal > MAX_TOTAL) fail(28, 'staged bounds');
  }
}
walk(DST);
if (actualPaths.size !== manifest.length || actualTotal !== total) fail(32, 'staged accounting');

for (const entry of manifest) {
  if (!actualPaths.has(entry.path)) fail(32, 'missing staged file:' + entry.path);
  const full = path.join(DST, entry.path);
  const st = fs.lstatSync(full);
  if (st.size !== entry.size) fail(32, 'staged size:' + entry.path);
  const bytes = fs.readFileSync(full);
  if (sha1Blob(bytes) !== entry.oid) fail(32, 'staged blob:' + entry.path);
  entry.sha256 = sha256(bytes);
}

const canonical = Buffer.from(JSON.stringify(manifest));
if (canonical.length > MAX_MANIFEST) fail(28, 'final manifest bytes');
const manifestDigest = sha256(canonical);
if (MODE === 'verify' && manifestDigest !== EXPECTED_MANIFEST) fail(33, 'staged manifest drift');
const receipt = {
  schemaVersion: 'BE9_SOURCE_STAGE_V1',
  mode: MODE,
  assessmentId: ASSESSMENT_ID,
  projectId: PROJECT_ID,
  sourceRevision: head,
  sourceTree: tree,
  fileCount: manifest.length,
  totalBytes: total,
  manifestBytes: canonical.length,
  manifestDigest,
  stagerImageId: STAGER_IMAGE_ID,
  stagingPolicyVersion: POLICY_VERSION,
  createdAt: new Date().toISOString(),
};
process.stdout.write('BE9_STAGE_RECEIPT=' + JSON.stringify(receipt) + '\n');
`;
