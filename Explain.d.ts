export interface ExplainOptions {
    /** Bytes between samples. Default 512 KB. Smaller = more detail, more perturbation. */
    intervalBytes?: number;
    /** Number of top stacks to include. Default 10. */
    topN?: number;
}

export interface ExplainStack {
    selfSize: number;
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
}

export interface ExplainResult {
    topStacks: ExplainStack[];
    samplingInterval: number;
    topN: number;
    error?: string;
}

export interface ExplainHandle {
    /** Resolves once the sampler is running. */
    started: Promise<void>;
    /**
     * Stop sampling and return top allocation stacks. Safe to call multiple
     * times; subsequent calls return { error: 'already stopped' }.
     */
    stop(): Promise<ExplainResult>;
}

/**
 * Start heap allocation sampling via node:inspector. Node-only.
 *
 * STRICT OPT-IN. Never active during a normal gated run -- the sampler
 * perturbs measurement. Use after a gate fails to identify allocator
 * stacks.
 */
export function startExplainSampling(options?: ExplainOptions): ExplainHandle;

/** Format an explain result as human-readable console output. */
export function formatExplainConsole(explainResult: ExplainResult): string;
