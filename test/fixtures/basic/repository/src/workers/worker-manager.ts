import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CandidateStore } from "../storage/candidate-store.js";
import type { Candidate, Evaluation } from "@/types.js";
export { ZodError } from "zod";

// This comment must not reach the outline.
export class WorkerManager<TCandidate extends Candidate = Candidate> {
  private concurrency = 4;
  readonly label: string = "primary";

  static {
    randomUUID();
  }

  constructor(
    private readonly store: CandidateStore,
    public retries = 3,
  ) {
    this.label = "worker";
  }

  async process(candidate: TCandidate): Promise<Evaluation> {
    const normalized = [candidate].map((item) => item.id.trim());
    await this.store.find(normalized[0]);
    return { candidateId: candidate.id, score: z.number().parse(1) };
  }

  map<TResult>(candidate: TCandidate, callback: (value: TCandidate) => TResult): TResult {
    return callback(candidate);
  }

  get capacity() {
    return this.concurrency;
  }

  set capacity(value: number) {
    this.concurrency = value;
  }
}

export const createWorker = (store: CandidateStore) => new WorkerManager(store);

export function normalizeId(id = "unknown") {
  return id.trim();
}

function bootstrap(): void {
  createWorker(new CandidateStore({ namespace: "fixture" }));
}

bootstrap();
