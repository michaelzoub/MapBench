// @ts-nocheck

export interface Candidate {
    id: string;
    tags?: string[];
}

export type Evaluation<TScore extends number = number> = {
    candidateId: string;
    score: TScore;
};

export enum WorkerState {
    Idle = "idle",
    Busy = "busy"
}
