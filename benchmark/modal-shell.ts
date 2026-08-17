#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Sandbox } from "modal";
import {
  downloadDirectoryFromModal,
  execModalCommand,
  modalOptionsFromEnvironment,
  ModalSandboxRuntime,
  uploadDirectoryToModal,
} from "./modal-sandbox.js";
export async function runSynchronizedModalCommand(
  sandbox: Sandbox,
  workspace: string,
  timeoutMs: number,
  command: string,
  onStdout?: (data: Buffer) => void,
  onStderr?: (data: Buffer) => void,
): Promise<number> {
  await uploadDirectoryToModal(sandbox, workspace, "/app");
  try {
    const result = await execModalCommand(
      sandbox,
      ["/bin/bash", "-lc", command],
      timeoutMs,
      onStdout,
      onStderr,
    );
    return result.exitCode;
  } finally {
    await downloadDirectoryFromModal(sandbox, "/app", workspace);
  }
}


export async function runModalShell(args: string[]): Promise<number> {
  if (args.length !== 5 || args[0] !== "sync-exec") {
    throw new Error("Modal shell bridge requires: sync-exec <sandbox-id> <workspace> <timeout-ms> <command>.");
  }
  const [, sandboxId, workspaceInput, timeoutInput, command] = args;
  const timeoutMs = Number(timeoutInput);
  if (!sandboxId || !workspaceInput || !command || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Modal shell bridge received invalid arguments.");
  }
  const workspace = path.resolve(workspaceInput);
  const runtime = new ModalSandboxRuntime(modalOptionsFromEnvironment());
  try {
    const sandbox = await runtime.fromId(sandboxId);
    return await runSynchronizedModalCommand(
      sandbox,
      workspace,
      timeoutMs,
      command,
      (data) => process.stdout.write(data),
      (data) => process.stderr.write(data),
    );
  } finally {
    runtime.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runModalShell(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 125;
  });
}
