import { promises as fs } from "node:fs";
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

  const snapshot = async (): Promise<string> => {
    const detected = await detectProject(options);
    const files = detected.languages.flatMap((language) => detected.files[language]).sort();
    const records = await Promise.all(files.map(async (fileName) => {
      const stats = await fs.stat(fileName);
      return `${fileName}\0${stats.size}\0${stats.mtimeMs}`;
    }));
    return records.join("\n");
  };
  let previous = await snapshot();
  const watcher = setInterval(() => {
    if (closed || running) return;
    void snapshot().then((current) => {
      if (current === previous) return;
      previous = current;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), 100);
    }).catch(onError);
  }, 150);
  return {
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(watcher);
    },
  };
}
