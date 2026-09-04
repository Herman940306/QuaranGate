import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as vscode from "vscode";

export type WorkspaceAttestation = Readonly<{
  workspaceUri: string;
  canonicalWorkspaceUri: string;
  scheme: string;
  remoteName: string;
  canonicalPath: string;
  extensionHostKind: "workspace";
  extensionUri: string;
}>;

export async function attestWorkspace(context: vscode.ExtensionContext): Promise<WorkspaceAttestation> {
  if (vscode.env.remoteName !== "wsl") {
    throw new Error("the spike must run in a VS Code Remote WSL extension host");
  }
  const extension = vscode.extensions.getExtension(context.extension.id);
  if (extension === undefined || extension.extensionKind !== vscode.ExtensionKind.Workspace) {
    throw new Error("the spike is not running as a workspace extension");
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length !== 1) {
    throw new Error("the spike requires exactly one open workspace folder");
  }
  const folder = folders[0];
  if (folder === undefined || folder.uri.scheme !== "file") {
    throw new Error("the WSL workspace must have a file URI");
  }
  const canonicalPath = await realpath(folder.uri.fsPath);
  const info = await stat(canonicalPath);
  if (!info.isDirectory() || !isAbsolute(canonicalPath) || canonicalPath.includes("\\")) {
    throw new Error("the workspace does not resolve to a canonical WSL directory");
  }
  return {
    workspaceUri: folder.uri.toString(true),
    canonicalWorkspaceUri: vscode.Uri.file(canonicalPath).toString(true),
    scheme: folder.uri.scheme,
    remoteName: vscode.env.remoteName,
    canonicalPath,
    extensionHostKind: "workspace",
    extensionUri: context.extensionUri.toString(true),
  };
}
