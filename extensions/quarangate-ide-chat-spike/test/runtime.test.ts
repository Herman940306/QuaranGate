import assert = require("node:assert/strict");
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertOwnerOnlyDirectory,
  cleanupRuntime,
  createRuntimePaths,
  writeRuntimeCredential,
} from "../src/runtime";

const WORKSPACE = "file:///home/herman/projects/quarangate-ide-session";

test("runtime directory and credential are owner-only and restart identity is fresh", async () => {
  const base = await mkdtemp(join(tmpdir(), "qg-spike-runtime-test-"));
  await chmod(base, 0o700);
  try {
    const first = await createRuntimePaths(base);
    const credential = await writeRuntimeCredential(first, WORKSPACE);
    const directoryInfo = await lstat(first.directory);
    const credentialInfo = await lstat(first.credentialPath);
    assert.equal(directoryInfo.mode & 0o077, 0);
    assert.equal(credentialInfo.mode & 0o077, 0);
    assert.equal(credential.secret, first.secret);
    assert.equal(Buffer.byteLength(first.socketPath, "utf8") <= 100, true);
    await cleanupRuntime(first);

    const second = await createRuntimePaths(base);
    assert.notEqual(second.instanceId, first.instanceId);
    assert.notEqual(second.secret, first.secret);
    assert.notEqual(second.socketPath, first.socketPath);
    await cleanupRuntime(second);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("owner-only directory assertion rejects permissive modes", async () => {
  const base = await mkdtemp(join(tmpdir(), "qg-spike-mode-test-"));
  try {
    await chmod(base, 0o755);
    await assert.rejects(assertOwnerOnlyDirectory(base), /permissions are not owner-only/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
