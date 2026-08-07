import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { CallGraph } from "./types.js";

export interface PythonParseResult {
  outlines: Record<string, string>;
  callgraph: CallGraph;
}

async function run(executable: string, request: string): Promise<PythonParseResult> {
  const parserPath = fileURLToPath(new URL("./python_parser.py", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [parserPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${executable} exited with code ${code ?? "unknown"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as PythonParseResult);
      } catch (error) {
        reject(new Error(`Python parser returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(request);
  });
}

export async function parsePythonProject(root: string, fileNames: readonly string[]): Promise<PythonParseResult> {
  const files = fileNames.map((fileName) => path.relative(root, fileName));
  const request = JSON.stringify({ root, files });
  const configured = process.env.PROJECT_OUTLINE_PYTHON;
  const executables = configured
    ? [configured]
    : ["python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3", "python3.9", "python"];
  let missingError: unknown;
  for (const executable of executables) {
    try {
      return await run(executable, request);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missingError = error;
        continue;
      }
      throw new Error(`Python parsing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Python 3.9 or newer is required to parse Python repositories.${missingError ? " Set PROJECT_OUTLINE_PYTHON to the interpreter path." : ""}`);
}
