import type { Candidate } from "../types.js";

export interface StoreOptions {
  namespace: string;
}

export class CandidateStore {
  private cache = new Map<string, Candidate>();

  constructor(public readonly options: StoreOptions) {
    this.cache.clear();
  }

  async find(id: string): Promise<Candidate | undefined> {
    return this.cache.get(id);
  }
}
