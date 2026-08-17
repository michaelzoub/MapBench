import { spawn } from "node:child_process";

export interface ProcessResult {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Elapsed wall time when each complete stdout line was observed. */
  stdoutLineElapsedMs: number[];
  timedOut: boolean;
  error?: string;
}

export async function runProcess(
  command: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    unsetEnv?: string[];
    stdin?: string;
    onStdout?: (chunk: string) => void;
  },
): Promise<ProcessResult> {
  if (command.length === 0) throw new Error("Cannot run an empty command.");
  const started = performance.now();
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let stdoutLineBuffer = "";
    const stdoutLineElapsedMs: number[] = [];
    let timer: NodeJS.Timeout;
    const childEnv = { ...process.env, ...options.env };
    for (const name of options.unsetEnv ?? []) delete childEnv[name];
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const finish = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - started);
      if (stdoutLineBuffer.length > 0) {
        stdoutLineElapsedMs.push(durationMs);
        stdoutLineBuffer = "";
      }
      resolve({ command, exitCode, stdout, stderr, durationMs, stdoutLineElapsedMs, timedOut, error });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      stdoutLineBuffer += text;
      let newline = stdoutLineBuffer.indexOf("\n");
      while (newline >= 0) {
        stdoutLineElapsedMs.push(Math.round(performance.now() - started));
        stdoutLineBuffer = stdoutLineBuffer.slice(newline + 1);
        newline = stdoutLineBuffer.indexOf("\n");
      }
      options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code));
    child.stdin.end(options.stdin);
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") child.kill("SIGKILL");
      else {
        try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }, 1_000).unref();
      }
    }, options.timeoutMs);
  });
}
