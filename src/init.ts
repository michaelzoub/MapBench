import { promises as fs } from "node:fs";
import path from "node:path";
import { assertSafeOutput } from "./files.js";
import {
  createManagedAgentsSection,
  MANAGED_SECTION_END,
  MANAGED_SECTION_START,
  outputReference,
} from "./instructions.js";
import type { InitResult, OutlineOptions } from "./types.js";

export async function initOutline(options: OutlineOptions = {}): Promise<InitResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const out = path.resolve(root, options.out ?? ".cartograph");
  assertSafeOutput(root, out);

  const agentsFile = path.join(root, "AGENTS.md");
  const section = createManagedAgentsSection(outputReference(root, out));
  let current: string | undefined;
  try {
    current = await fs.readFile(agentsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (current === undefined) {
    await fs.writeFile(agentsFile, `${section}\n`, "utf8");
    return { root, agentsFile, changed: true, created: true };
  }

  const start = current.indexOf(MANAGED_SECTION_START);
  const end = current.indexOf(MANAGED_SECTION_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error(`Refusing to update malformed cartograph section in ${agentsFile}`);
  }

  let next: string;
  if (start === -1) {
    next = `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${section}\n`;
  } else {
    const endOffset = end + MANAGED_SECTION_END.length;
    next = `${current.slice(0, start)}${section}${current.slice(endOffset)}`;
  }

  if (next === current) return { root, agentsFile, changed: false, created: false };
  await fs.writeFile(agentsFile, next, "utf8");
  return { root, agentsFile, changed: true, created: false };
}
