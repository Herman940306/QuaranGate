import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_LINUX_SOCKET_PATH_BYTES = 100;

export type RuntimePaths = Readonly<{
  instanceId: string;
  directory: string;
  socketPath: string;
  credentialPath: string;
  secret: string;
}>;

export type RuntimeCredential = Readonly<{
  version: 1;
  instanceId: string;
  socketPath: string;
  workspace: string;
  secret: string;
}>;

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Unix user identity is unavailable");
  }
  return uid;
}

async function assertSafeBaseDirectory(baseDirectory: string): Promise<void> {
  if (!isAbsolute(baseDirectory)) {
    throw new Error("runtime base directory must be absolute");
  }
  const info = await lstat(baseDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("runtime base must be a real directory");
  }
  const worldWritable = (info.mode & 0o002) !== 0;
  const sticky = (info.mode & 0o1000) !== 0;
  if (worldWritable && !sticky) {
    throw new Error("world-writable runtime base must have the sticky bit");
  }
}

export async function assertOwnerOnlyDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("runtime path is not a real directory");
  }
  if (info.uid !== currentUid()) {
    throw new Error("runtime directory is not owned by the extension-host user");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error("runtime directory permissions are not owner-only");
  }
}

export async function createRuntimePaths(baseDirectory = tmpdir()): Promise<RuntimePaths> {
  await assertSafeBaseDirectory(baseDirectory);
  const uid = currentUid();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const instanceId = randomBytes(16).toString("hex");
    const directory = join(baseDirectory, `qg-ide-chat-${uid}-${instanceId}`);
    try {
      await mkdir(directory, { mode: DIRECTORY_MODE });
      await chmod(directory, DIRECTORY_MODE);
      await assertOwnerOnlyDirectory(directory);
      const socketPath = join(directory, "agent.sock");
      if (Buffer.byteLength(socketPath, "utf8") > MAX_LINUX_SOCKET_PATH_BYTES) {
        await rmdir(directory);
        throw new Error("runtime socket path is too long for a Linux Unix-domain socket");
      }
      return {
        instanceId,
        directory,
        socketPath,
        credentialPath: join(directory, "credential.json"),
        secret: randomBytes(32).toString("base64url"),
      };
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("could not allocate a unique runtime directory");
}

export async function writeRuntimeCredential(
  paths: RuntimePaths,
  workspace: string,
): Promise<RuntimeCredential> {
  await assertOwnerOnlyDirectory(paths.directory);
  const credential: RuntimeCredential = {
    version: 1,
    instanceId: paths.instanceId,
    socketPath: paths.socketPath,
    workspace,
    secret: paths.secret,
  };
  const handle = await open(paths.credentialPath, "wx", FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(credential)}\n`, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
  await chmod(paths.credentialPath, FILE_MODE);
  const info = await lstat(paths.credentialPath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
    throw new Error("credential file ownership or permissions are unsafe");
  }
  return credential;
}

async function unlinkOwnedFile(path: string, expected: "file" | "socket"): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
  const rightType = expected === "file" ? info.isFile() : info.isSocket();
  if (!rightType || info.isSymbolicLink() || info.uid !== currentUid()) {
    throw new Error(`refusing to remove unsafe runtime ${expected}`);
  }
  await unlink(path);
}

export async function cleanupRuntime(paths: RuntimePaths): Promise<void> {
  await unlinkOwnedFile(paths.socketPath, "socket");
  await unlinkOwnedFile(paths.credentialPath, "file");
  await rmdir(paths.directory);
}

export async function assertSocketReady(socketPath: string): Promise<void> {
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== currentUid()) {
    throw new Error("IPC endpoint is not an owner-controlled Unix-domain socket");
  }
  await chmod(socketPath, FILE_MODE);
  await access(socketPath, constants.R_OK | constants.W_OK);
}
