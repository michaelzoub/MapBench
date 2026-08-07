import path from "node:path";
import ts from "typescript";
import { isInside } from "./files.js";
import { generateOutline } from "./generate.js";
import { detectProject } from "./detection.js";
import type { OutlineOptions, WatchHandle } from "./types.js";

export async function watchOutline(
  options: OutlineOptions = {},
  onGenerate: (message: string) => void = console.log,
  onError: (error: unknown) => void = console.error,
): Promise<WatchHandle> {
  const initial = await generateOutline(options);
  onGenerate(`Generated ${initial.filesWritten} outline file${initial.filesWritten === 1 ? "" : "s"}.`);
  const context = await detectProject(options);
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let running = false;
  let rerun = false;

  const run = async (): Promise<void> => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      const result = await generateOutline(options);
      onGenerate(`Generated ${result.filesWritten} outline file${result.filesWritten === 1 ? "" : "s"}.`);
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (rerun && !closed) {
        rerun = false;
        void run();
      }
    }
  };

  const watcher = ts.sys.watchDirectory?.(context.root, (changedPath) => {
    const absolute = path.resolve(changedPath);
    if (closed || isInside(context.out, absolute)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), 100);
  }, true);

  if (!watcher) throw new Error("Recursive directory watching is unavailable in this environment.");
  return {
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
