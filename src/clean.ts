import { promises as fs } from "node:fs";
import path from "node:path";
import { assertOutputIsManaged, assertOutputPathHasNoSymlinks, assertSafeOutput } from "./files.js";
import type { OutlineOptions } from "./types.js";

export async function cleanOutline(options: OutlineOptions = {}): Promise<string> {
  const root = path.resolve(options.root ?? process.cwd());
  const out = path.resolve(root, options.out ?? ".project-outline");
  assertSafeOutput(root, out);
  await assertOutputPathHasNoSymlinks(root, out);
  await assertOutputIsManaged(out, root);
  await fs.rm(out, { recursive: true, force: true });
  return out;
}
