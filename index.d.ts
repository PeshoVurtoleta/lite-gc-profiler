export const GC_MINOR: 1;
export const GC_MAJOR: 4;
export const GC_INCREMENTAL: 8;
export const GC_WEAKCB: 16;

export type GcSource = 'gc' | 'heap' | 'none';

export interface GcStat {
    /** Total GC events observed in the window. */
    count: number;
    /** Sum of pause durations (ms). */
    totalMs: number;
    /** Longest single pause (ms). */
    maxMs: number;
    /** Mean pause (ms). */
    avgMs: number;
    /** p99 pause (ms) over the retained window. */
    p99Ms: number;
    /** Minor (Scavenge) collections. */
    minor: number;
    /** Major (Mark-Sweep-Compact) collections -- the heap-pressure signal. */
    major: number;
    /** Incremental marking steps. */
    incremental: number;
    /** Weak-callback processing events. */
    weakcb: number;
}

export interface HeapStat {
    /** Whether heap figures are present (Chrome, or explicit usedBytes samples). */
    supported: boolean;
    /** Most recent sampled used-heap size (bytes). */
    used: number;
    /** Peak sampled used-heap size (bytes). */
    peak: number;
    /** First sampled used-heap size (bytes). */
    firstSample: number;
    /** Number of heap samples taken. */
    samples: number;
    /** Cumulative positive heap growth (bytes) -- an allocation proxy. */
    allocBytes: number;
    /** Allocation rate (bytes/sec) over sampled elapsed time. */
    allocRateBytesPerSec: number;
    /** Count of sampled heap decreases (likely collections). */
    gcDrops: number;
    /** Cumulative bytes freed across drops. */
    freedBytes: number;
}

export interface GcSummary {
    schema: 'lite-gc/1';
    /** Live signal: 'gc' (precise, node), 'heap' (Chrome heuristic), or 'none'. */
    source: GcSource;
    supported: boolean;
    gc: GcStat;
    heap: HeapStat;
    frames: { count: number; long: number };
    [key: string]: unknown;
}

export interface GcProfilerOptions {
    /** Sample performance.memory automatically when available. Default true. */
    heap?: boolean;
    /** Attach the GC observer immediately. Default false. */
    autoStart?: boolean;
}

export class GcProfiler {
    constructor(capacity?: number, options?: GcProfilerOptions);

    readonly supported: boolean;
    readonly source: GcSource;
    readonly running: boolean;
    readonly gcCount: number;
    readonly majorCount: number;
    readonly minorCount: number;

    /** Attach the perf_hooks GC observer (node). No-op where 'gc' entries are unsupported. */
    start(): this;
    /** Detach the observer. */
    stop(): this;

    /** Inject a GC event directly (tests, or a custom source). */
    record(kind: number, durationMs: number): this;

    /**
     * Sample the JS heap once. In Chrome, omit `usedBytes` to read performance.memory.
     * Elsewhere pass a figure explicitly, e.g. process.memoryUsage().heapUsed.
     * Zero-allocation; a no-op if neither a figure nor performance.memory is available.
     */
    sampleHeap(now?: number, usedBytes?: number): this;

    /** Record a frame duration for the long-frame anomaly heuristic (any environment). */
    markFrame(frameMs: number): this;

    /** Snapshot the current window; `meta` merges over the summary. */
    summary(meta?: Record<string, unknown>): GcSummary;

    reset(): this;
    destroy(): this;
}

export interface GcRules {
    /** Max allowed major collections. Default 0. */
    maxMajor?: number;
    /** Max allowed minor collections. */
    maxMinor?: number;
    /** Max allowed single pause (ms). */
    maxPauseMs?: number;
    /** Max allowed total pause (ms). */
    maxTotalMs?: number;
    /** Max allowed allocation rate (bytes/sec), from the heap path. */
    maxAllocRate?: number;
}

export interface GcViolation {
    metric: string;
    limit: number;
    actual: number;
    reason: string;
}

export interface GcGateResult {
    ok: boolean;
    violations: GcViolation[];
    source: GcSource;
}

export const GC_DEFAULT_RULES: GcRules;

export function checkNoGc(summary: GcSummary, rules?: GcRules): GcGateResult;

export class GcBudgetError extends Error {
    name: 'GcBudgetError';
    report: GcGateResult;
}

export function assertNoGc(summary: GcSummary, rules?: GcRules): GcGateResult;
