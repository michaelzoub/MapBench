// @ts-nocheck
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { assertWorkspaceOutputPath, assertWorkspacePath, assertWorkspacePattern } from "./path-policy.js";

const execFileAsync = promisify(execFile);

function safeTool(tool: any, validate: (params: Record<string, unknown>) => Promise<void>) {
  return {
    ...tool,
    async execute(id: string, params: Record<string, unknown>, signal: AbortSignal, update: unknown) {
      await validate(params);
      return tool.execute(id, params, signal, update);
    },
  };
}
function dockerBashOperations(container: string) {
  return {
    exec(command: string, _cwd: string, options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
    }): Promise<{ exitCode: number | null }> {
      const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number | null }>();
      const docker = process.env.MAPBENCH_DOCKER ?? "docker";
      const child = spawn(docker, ["exec", "--workdir", "/app", container, "/bin/bash", "-lc", command], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", options.onData);
      child.stderr.on("data", options.onData);
      let timer: NodeJS.Timeout | undefined;
      const stop = () => child.kill("SIGKILL");
      if (options.timeout && options.timeout > 0) timer = setTimeout(stop, options.timeout);
      options.signal?.addEventListener("abort", stop, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
        resolve({ exitCode: code });
      });
      return promise;
    },
  };
}
function modalBashOperations(sandboxId: string, root: string) {
  return {
    exec(command: string, _cwd: string, options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
    }): Promise<{ exitCode: number | null }> {
      const helper = process.env.MAPBENCH_MODAL_HELPER;
      const runtime = process.env.MAPBENCH_MODAL_HELPER_RUNTIME;
      if (!helper || !runtime) return Promise.reject(new Error("Modal shell bridge is not configured."));
      const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number | null }>();
      const child = spawn(runtime, [helper, "sync-exec", sandboxId, root, String(options.timeout ?? 120_000), command], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", options.onData);
      child.stderr.on("data", options.onData);
      const stop = () => child.kill("SIGKILL");
      options.signal?.addEventListener("abort", stop, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        options.signal?.removeEventListener("abort", stop);
        resolve({ exitCode: code });
      });
      return promise;
    },
  };
}



const querySchema = Type.Object({
  operation: Type.Union([
    Type.Literal("find"),
    Type.Literal("inspect"),
    Type.Literal("explore"),
    Type.Literal("trace"),
  ]),
  query: Type.Optional(Type.String({ description: "Search terms or symbol for find, inspect, or explore" })),
  from: Type.Optional(Type.String({ description: "Starting symbol for trace" })),
  to: Type.Optional(Type.String({ description: "Destination symbol for trace" })),
  direction: Type.Optional(Type.Union([Type.Literal("callers"), Type.Literal("callees"), Type.Literal("both")])),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export default function mapbenchTools(pi: any) {
  const root = path.resolve(process.cwd());
  const validatePath = async (params: Record<string, unknown>) => {
    await assertWorkspacePath(root, typeof params.path === "string" ? params.path : ".");
  };
  const validateFind = async (params: Record<string, unknown>) => {
    await validatePath(params);
    const pattern = String(params.pattern ?? "");
    assertWorkspacePattern(pattern, "Find patterns");
  };
  const validateGrep = async (params: Record<string, unknown>) => {
    await validatePath(params);
    const glob = String(params.glob ?? "");
    assertWorkspacePattern(glob, "Grep globs");
  };

  pi.registerTool(safeTool(createReadTool(root), validatePath));
  pi.registerTool(safeTool(createGrepTool(root), validateGrep));
  pi.registerTool(safeTool(createFindTool(root), validateFind));
  pi.registerTool(safeTool(createLsTool(root), validatePath));
  const dockerContainer = process.env.MAPBENCH_DOCKER_CONTAINER;
  const modalSandbox = process.env.MAPBENCH_MODAL_SANDBOX_ID;
  if (dockerContainer || modalSandbox) {
    const validateOutput = async (params: Record<string, unknown>) => {
      await assertWorkspaceOutputPath(root, typeof params.path === "string" ? params.path : ".");
    };
    pi.registerTool(safeTool(createEditTool(root), validatePath));
    pi.registerTool(safeTool(createWriteTool(root), validateOutput));
    pi.registerTool(createBashTool(root, {
      operations: dockerContainer ? dockerBashOperations(dockerContainer) : modalBashOperations(modalSandbox, root),
      exposeSessionEnvironment: false,
    }));
  }


  const queryHelper = process.env.MAPBENCH_QUERY_HELPER;
  if (queryHelper) {
    pi.registerTool({
      name: "mapbench_query",
      label: "MapBench call graph query",
      description: "Query the condition-provided static call graph. Use find for discovery, inspect for one symbol, explore for a bounded neighborhood, and trace for a path.",
      parameters: querySchema,
      async execute(_id: string, params: Record<string, unknown>) {
        const operation = String(params.operation);
        const args = [queryHelper, operation];
        if (operation === "trace") {
          if (!params.from || !params.to) throw new Error("trace requires from and to symbols");
          args.push(String(params.from), String(params.to));
        } else {
          if (!params.query) throw new Error(`${operation} requires query`);
          args.push(String(params.query));
        }
        if (params.direction) args.push("--direction", String(params.direction));
        if (params.depth !== undefined) args.push("--depth", String(params.depth));
        if (params.maxDepth !== undefined) args.push("--max-depth", String(params.maxDepth));
        if (params.limit !== undefined) args.push("--limit", String(params.limit));
        try {
          const result = await execFileAsync(process.execPath, args, { cwd: path.dirname(queryHelper), encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
          return { content: [{ type: "text", text: result.stdout.trim() }], details: { operation } };
        } catch (error: any) {
          const text = String(error?.stdout || error?.stderr || error?.message || error);
          throw new Error(text);
        }
      },
    });
  }
}
