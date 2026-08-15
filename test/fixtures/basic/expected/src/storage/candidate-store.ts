// @ts-nocheck

import type { Candidate } from "../types.js";

export interface StoreOptions {
  namespace: string;
}

export class CandidateStore {
  private cache = undefined;

  constructor(public readonly options: StoreOptions) { }

  async find(id: string): Promise<Candidate | undefined> { }
}
