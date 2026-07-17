export const VERSION: '1.3.2';

export const GC_MINOR: 1;
export const GC_MAJOR: 4;
export const GC_INCREMENTAL: 8;
export const GC_WEAKCB: 16;

export type GcSource = 'gc' | 'heap' | 'uasm' | 'none';

/** Three-state gate verdict. See VERDICT_MATRIX for verifiability by (rule, source). */
export type GcVerdict = 'pass' | 'fail' | 'inconclusive';

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

/**
 * Per-phase GC stats. Mirrors GcStat but omits p99Ms (per-phase percentile would
 * require a duration ring per phase; add if needed by a future gate).
 */
export interface PhaseGcStat {
    count: number;
    totalMs: number;
    maxMs: number;
    avgMs: number;
    minor: number;
    major: number;
    incremental: number;
    weakcb: number;
}

export interface PhaseSnapshot {
    gc: PhaseGcStat;
}

/**
 * UASM stats block (G12). Populated by sampleUasm() calls; always present in
 * summary output. `supported: false` and zeros when the API is unavailable
 * OR when it is available but the user never called sampleUasm().
 *
 * measureUserAgentSpecificMemory() is Chrome's accurate but async memory API.
 * Requires cross-origin isolation (COOP+COEP headers). Coarse and slow --
 * not for per-frame use. Typical use is a few times per measurement window
 * (start, mid, end) to capture growth rate.
 */
export interface UasmStat {
    supported: boolean;
    /** Most recent measurement (bytes). */
    bytes: number;
    /** Highest measurement seen (bytes). */
    peak: number;
    /** First measurement (bytes) -- for growth-rate baselining. */
    firstSample: number;
    /** Number of successful samples. */
    samples: number;
    /** Bytes/sec across the sampled window; 0 when samples < 2. */
    growthRate: number;
}

export interface GcSummary {
    schema: 'lite-gc/1';
    /**
     * Live signal: 'gc' (precise, node), 'heap' (Chrome heuristic),
     * 'uasm' (Chrome accurate, opt-in via constructor), or 'none'.
     */
    source: GcSource;
    supported: boolean;
    gc: GcStat;
    heap: HeapStat;
    uasm: UasmStat;
    frames: { count: number; long: number };
    /**
     * Per-phase snapshots. Empty object when no phase() calls happened. A phase
     * appears here iff phase(name) was called with that name; its counters may
     * be zero if no events fell within its boundaries.
     */
    phases: Record<string, PhaseSnapshot>;
    /**
     * Per-region snapshots (G10). Empty object when no enter() calls happened.
     * A region appears here iff enter(name) was called with that name. Includes
     * an "unattributed" bucket only when events fell outside all region
     * intervals during a region-active window.
     *
     * Attribution is FIRING-SITE, not allocator. Use Explain mode for
     * allocator attribution.
     */
    byRegion: Record<string, PhaseSnapshot>;
    [key: string]: unknown;
}

export interface GcProfilerOptions {
    /** Sample performance.memory automatically when available. Default true. */
    heap?: boolean;
    /** Attach the GC observer immediately. Default false. */
    autoStart?: boolean;
    /**
     * Explicit source override. Default 'auto' -- detect: gc on node, heap on
     * Chrome, none otherwise. Set to 'uasm' to use
     * performance.measureUserAgentSpecificMemory as the primary gate channel
     * (throws if the API is unavailable or the page is not cross-origin-
     * isolated).
     */
    source?: 'auto' | 'gc' | 'heap' | 'uasm' | 'none';
}

export interface SettleOptions {
    /** Consecutive quiet ticks required to declare drained. Default 2. */
    quietTicks?: number;
    /** Hard timeout in ms. Default 200. On timeout, resolves with drained:false. */
    maxWaitMs?: number;
}

export interface SettleResult {
    /** True if the queue drained; false if maxWaitMs elapsed first. */
    drained: boolean;
    /** Elapsed ms from settle() call to resolve. */
    waited: number;
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

    /**
     * Inject a GC event directly (tests, or a custom source).
     * `startTime` defaults to performance.now(); pass explicit values to inject
     * events into specific phases deterministically.
     */
    record(kind: number, durationMs: number, startTime?: number): this;

    /**
     * Mark a phase boundary. Everything from this call until the next phase()
     * call (or the end of the measurement window) is attributed to `name`.
     * Repeated calls with the same current name are a no-op.
     * @throws {TypeError} if name is not a non-empty string
     * @throws {RangeError} on capacity exhaustion (32 unique phases, 1024 boundaries)
     */
    phase(name: string): this;

    /**
     * Wait for the GC observer's delivery queue to drain. Resolves after
     * `quietTicks` consecutive macrotask ticks with no new batches, or after
     * `maxWaitMs` elapses. A no-op on runtimes with no observer attached.
     *
     * Use this before reading summary() to make results deterministic. On
     * timeout (drained:false), callers should downgrade the verdict to
     * inconclusive rather than treat the summary as authoritative.
     */
    settle(options?: SettleOptions): Promise<SettleResult>;

    /**
     * Enter a region. Regions nest -- multiple regions can be active at once,
     * and enter/exit must pair LIFO. The innermost open region is what GC
     * events attribute to.
     *
     * Firing-site attribution: events attribute to where the pause fired, not
     * to who allocated the garbage that caused it. Use Explain mode for
     * allocator attribution.
     * @throws {TypeError} if name is not a non-empty string
     * @throws {RangeError} on capacity exhaustion (32 regions, 16 nesting, 2048 intervals)
     */
    enter(name: string): this;

    /**
     * Exit the innermost open region.
     * @throws {RangeError} if called with no open region.
     */
    exit(): this;

    /**
     * Sample the JS heap once. In Chrome, omit `usedBytes` to read performance.memory.
     * Elsewhere pass a figure explicitly, e.g. process.memoryUsage().heapUsed.
     * Zero-allocation; a no-op if neither a figure nor performance.memory is available.
     */
    sampleHeap(now?: number, usedBytes?: number): this;

    /**
     * Take a UASM measurement via performance.measureUserAgentSpecificMemory().
     * Returns a Promise; the measurement is async and can take tens of ms.
     *
     * On runtimes without the API (or without cross-origin isolation), no-ops
     * and returns a resolved Promise with { supported: false }. Coarse and
     * slow: never call per-frame. Typical use is a few times per measurement
     * window (start, mid, end) to capture growth rate.
     */
    sampleUasm(now?: number): Promise<{ supported: boolean; bytes?: number }>;

    /** Record a frame duration for the long-frame anomaly heuristic (any environment). */
    markFrame(frameMs: number): this;

    /** Snapshot the current window; `meta` merges over the summary. */
    summary(meta?: Record<string, unknown>): GcSummary;

    reset(): this;
    destroy(): this;
}

/** Global rules the gate understands. All optional; only rules set are checked. */
export interface GcRulesBase {
    /** Max allowed major collections. Default 0 (only when rules argument is omitted). */
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

export type GcRuleName = keyof GcRulesBase;

/**
 * Rules accepted by checkNoGc / assertNoGc. Global rules mirror v1.0.0; the
 * optional `phases` map applies per-phase rules to summary.phases[name].gc.
 * A phase referenced here that was never declared via profiler.phase(name)
 * contributes an inconclusive verdict.
 */
export interface GcRules extends GcRulesBase {
    phases?: Record<string, GcRulesBase>;
    /** Per-region rules (G10). Attribution is firing-site. */
    perRegion?: Record<string, GcRulesBase>;
}

export interface GcViolation {
    metric: string;
    limit: number;
    actual: number;
    reason: string;
}

/**
 * Report from checkNoGc.
 *   verdict     -- three-state outcome
 *   ok          -- true iff verdict === 'pass' (v1.0.0 back-compat)
 *   violations  -- rules the source could verify AND that failed
 *   checked     -- map from rule-name -> was-verifiable, present only for rules the caller set
 *   source      -- the summary's source, copied for convenience
 */
export interface GcGateResult {
    verdict: GcVerdict;
    ok: boolean;
    violations: GcViolation[];
    /** Global rules the caller set: name -> was-verifiable. G1 shape, unchanged. */
    checked: Partial<Record<GcRuleName, boolean>>;
    /**
     * Per-phase rules the caller set: phase-name -> (rule-name -> was-verifiable).
     * Empty when the caller passed no `phases` block. A phase entry appears here
     * iff the caller declared rules for it.
     */
    checkedByPhase: Record<string, Partial<Record<GcRuleName, boolean>>>;
    /**
     * Per-region rules the caller set (G10). Same shape as checkedByPhase.
     */
    checkedByRegion: Record<string, Partial<Record<GcRuleName, boolean>>>;
    source: GcSource;
}

export const GC_DEFAULT_RULES: GcRules;

/**
 * Verifiability matrix.
 *   'yes'       -- always verifiable on this source
 *   'no'        -- never verifiable on this source
 *   'needsHeap' -- verifiable iff summary.heap.samples >= 2
 */
export type GcVerifiability = 'yes' | 'no' | 'needsHeap';
export const VERDICT_MATRIX: Readonly<Record<GcRuleName, Readonly<Record<GcSource, GcVerifiability>>>>;

export function checkNoGc(summary: GcSummary, rules?: GcRules): GcGateResult;

export interface AssertNoGcOptions {
    /** If true, inconclusive verdicts do not throw. Default false. */
    allowInconclusive?: boolean;
}

export class GcBudgetError extends Error {
    name: 'GcBudgetError';
    report: GcGateResult;
}

export class GcInconclusiveError extends Error {
    name: 'GcInconclusiveError';
    report: GcGateResult;
}

/**
 * Assert a summary passes the rules.
 *   verdict='fail'         -> throws GcBudgetError
 *   verdict='inconclusive' -> throws GcInconclusiveError, unless { allowInconclusive: true }
 *   verdict='pass'         -> returns the report
 */
export function assertNoGc(summary: GcSummary, rules?: GcRules, options?: AssertNoGcOptions): GcGateResult;

// ---- differential gate (G4) ----

/**
 * Rules for compareGc. All optional; gate on the delta (candidate - control).
 */
export interface GcDifferentialRules {
    maxExtraMajor?: number;
    maxExtraMinor?: number;
    maxExtraPauseMs?: number;
    maxExtraTotalMs?: number;
    maxExtraAllocRate?: number;
}

export type GcDifferentialRuleName = keyof GcDifferentialRules;

export interface GcDifferentialResult {
    verdict: GcVerdict;
    ok: boolean;
    violations: GcViolation[];
    checked: Partial<Record<GcDifferentialRuleName, boolean>>;
    /** 'gc' | 'heap' | 'none' when sources match; 'mixed' when they don't. */
    source: GcSource | 'mixed';
    controlSource: GcSource;
    candidateSource: GcSource;
    /** Populated when verdict is 'inconclusive' due to source_mismatch. */
    reason?: string;
}

export const GC_DEFAULT_DIFFERENTIAL_RULES: GcDifferentialRules;

export function compareGc(
    control: GcSummary,
    candidate: GcSummary,
    rules?: GcDifferentialRules
): GcDifferentialResult;

export function assertCompare(
    control: GcSummary,
    candidate: GcSummary,
    rules?: GcDifferentialRules,
    options?: AssertNoGcOptions
): GcDifferentialResult;

// ---- rep-aware gating (G5) ----

export interface GcStatsBlock {
    min: number;
    median: number;
    max: number;
    /** Raw values across reps, in insertion order. */
    all: number[];
}

export interface GcAggregate {
    reps: number;
    /** Unique source strings across reps. Length > 1 means mixed. */
    sources: GcSource[];
    gc: {
        major: GcStatsBlock;
        minor: GcStatsBlock;
        incremental: GcStatsBlock;
        weakcb: GcStatsBlock;
        maxMs: GcStatsBlock;
        totalMs: GcStatsBlock;
        p99Ms: GcStatsBlock;
        count: GcStatsBlock;
    };
    heap: {
        allocRateBytesPerSec: GcStatsBlock;
        allocBytes: GcStatsBlock;
        gcDrops: GcStatsBlock;
        samples: GcStatsBlock;
    };
    /** The input summaries, unchanged. */
    perRep: GcSummary[];
}

/**
 * Rep aggregation policies:
 *   'all-clean'  -> every rep must satisfy (uses max)
 *   'best-clean' -> at least one rep must satisfy (uses min)
 *   'median'     -> median across reps must satisfy
 *   'quorum-N'   -> at least N reps must satisfy (e.g. 'quorum-8')
 */
export type GcRepPolicy = 'all-clean' | 'best-clean' | 'median' | string;

export interface GateRepsOptions extends AssertNoGcOptions {
    /** Per-rule policy overrides. Missing entries fall back to REP_POLICY_DEFAULTS. */
    policy?: Partial<Record<GcRuleName, GcRepPolicy>>;
}

export interface GcRepGateResult {
    verdict: GcVerdict;
    ok: boolean;
    violations: GcViolation[];
    checked: Partial<Record<GcRuleName, boolean>>;
    source: GcSource | 'mixed';
    reps: number;
    sources: GcSource[];
    aggregate: GcAggregate;
    /** Applied policy per rule the caller set. */
    policy: Partial<Record<GcRuleName, GcRepPolicy>>;
    /** Populated when verdict is 'inconclusive' due to mixed_sources. */
    reason?: string;
}

/** D4-approved defaults per rule. */
export const REP_POLICY_DEFAULTS: Record<GcRuleName, GcRepPolicy>;

export function aggregateGc(summaries: GcSummary[]): GcAggregate;

export function gateReps(
    summaries: GcSummary[],
    rules?: GcRules,
    options?: GateRepsOptions
): GcRepGateResult;

export function assertReps(
    summaries: GcSummary[],
    rules?: GcRules,
    options?: GateRepsOptions
): GcRepGateResult;

// ---- baseline lock (G6) ----

export interface GcFingerprint {
    node: string;
    v8: string;
    platform: string;
    arch: string;
    cpu: string;
    [key: string]: string;
}

export interface GcBaseline {
    schema: 'lite-gc-baseline/1';
    fingerprint: GcFingerprint;
    capturedAt: string;
    reps: number;
    sources: GcSource[];
    gc: Record<string, { min: number; median: number; max: number }>;
    heap: Record<string, { min: number; median: number; max: number }>;
}

export interface CheckAgainstBaselineOptions extends AssertNoGcOptions {
    /** Proceed past fingerprint mismatch. Report body carries fingerprintMismatchAccepted:true. */
    acceptFingerprintMismatch?: boolean;
}

export interface GcBaselineResult {
    verdict: GcVerdict;
    ok: boolean;
    violations: Array<{
        metric: string;
        baselineMax: number;
        currentMedian: number;
        reason: string;
    }>;
    checked: Record<string, boolean>;
    source: GcSource | 'unknown';
    baselineFingerprint?: GcFingerprint;
    currentFingerprint?: GcFingerprint;
    /** Populated on inconclusive. */
    reason?: string;
    /** True when acceptFingerprintMismatch was used. */
    fingerprintMismatchAccepted?: boolean;
}

export function captureFingerprint(): GcFingerprint;
export function createBaseline(aggregate: GcAggregate): GcBaseline;
export function checkAgainstBaseline(
    currentAggregate: GcAggregate,
    baseline: GcBaseline,
    options?: CheckAgainstBaselineOptions
): GcBaselineResult;
export function assertAgainstBaseline(
    currentAggregate: GcAggregate,
    baseline: GcBaseline,
    options?: CheckAgainstBaselineOptions
): GcBaselineResult;

// ---- report kind discriminator (G7 addition) ----

/**
 * Discriminator on every report shape. Formatters dispatch on this field.
 */
export type GcReportKind = 'gc' | 'compare' | 'reps' | 'baseline';

// GcGateResult, GcDifferentialResult, GcRepGateResult, GcBaselineResult all
// carry `kind` in v1.3.0+. Declared here as an intersection augmentation
// rather than re-declaring the interfaces.
declare module './Gc.js' {
    interface GcGateResult { kind: 'gc'; }
    interface GcDifferentialResult { kind: 'compare'; }
    interface GcRepGateResult { kind: 'reps'; }
    interface GcBaselineResult { kind: 'baseline'; }
}

// ---- formatters (G7) ----

/**
 * Any report produced by checkNoGc, compareGc, gateReps, checkAgainstBaseline.
 * Formatters accept the union; they dispatch on the `kind` field.
 */
export type GcReport = GcGateResult | GcDifferentialResult | GcRepGateResult | GcBaselineResult;

/** Human-readable, monospace-aligned. Suitable for stderr and CI job logs. */
export function formatConsole(report: GcReport): string;

/** Stable versioned JSON envelope. Round-trippable. */
export function formatJson(report: GcReport): string;

/** GitHub-flavored markdown, PR-comment ready. ASCII-only output. */
export function formatMarkdown(report: GcReport): string;

/** GitHub Actions workflow annotations (::error::/::warning::/::notice::). */
export function formatGithubAnnotations(report: GcReport): string;

// ---- per-op primitives (Batch 6, G14/G15/G16) ----

/**
 * Function signature accepted by measureOps and its convenience forms.
 * `i` is the iteration index (0-based). Return value is ignored.
 */
export type MeasureOpsFn = (i: number) => unknown;

/**
 * Rule set for per-op gating.
 *   maxBytesPerOp     -- max bytes allocated per iteration (heap delta / ops)
 *   maxMajorsPerKOp   -- max major GCs per 1000 ops
 *   maxMinorsPerKOp   -- max minor GCs per 1000 ops
 *   maxPauseMsPerOp   -- max total pause milliseconds per op (totalMs / ops)
 * All optional; only rules present are checked.
 */
export interface OpsRules {
    maxBytesPerOp?: number;
    maxMajorsPerKOp?: number;
    maxMinorsPerKOp?: number;
    maxPauseMsPerOp?: number;
}

/**
 * Delta rules for compareOps -- how much the candidate is allowed to exceed
 * the control on each per-op metric.
 */
export interface CompareOpsRules {
    maxExtraBytesPerOp?: number;
    maxExtraMajorsPerKOp?: number;
    maxExtraMinorsPerKOp?: number;
    maxExtraPauseMsPerOp?: number;
}

/**
 * Options for measureOps and its convenience forms (assertOps, compareOps).
 * assertOps/compareOps additionally accept `allowInconclusive`.
 */
export interface MeasureOpsOptions {
    /** Steady-phase iteration count. Required, must be a positive integer. */
    ops: number;
    /** Warmup iteration count. Default 0. Excluded from bytesPerOp/opsPerSec. */
    warmup?: number;
    /** GcProfiler source override. Default 'auto'. */
    source?: 'auto' | 'gc' | 'heap' | 'uasm' | 'none';
    /** GcProfiler pause-ring capacity. Default 256. */
    capacity?: number;
    /** For assert*Ops only: skip throw on inconclusive. */
    allowInconclusive?: boolean;
}

/**
 * A measureOps result. `bytesPerOp` is null when the source cannot provide a
 * memory signal (source='none'); otherwise it's the steady-phase heap delta
 * divided by ops.
 */
export interface MeasureOpsResult {
    schema: 'lite-gc-ops/1';
    ops: number;
    warmupOps: number;
    elapsedMs: number;
    opsPerSec: number;
    bytesPerOp: number | null;
    source: GcSource;
    summary: GcSummary;
}

/** Per-op gate report; use assertOps to throw instead. */
export interface OpsGateResult {
    kind: 'ops';
    verdict: 'pass' | 'fail' | 'inconclusive';
    checked: Partial<Record<keyof OpsRules, boolean>>;
    violations: Array<{ metric: string; limit: number; actual: number; reason: string }>;
    ok: boolean;
    ops: number;
    opsPerSec: number;
    bytesPerOp: number | null;
    source: GcSource;
    summary: GcSummary;
}

/** compareOps report shape. */
export interface CompareOpsResult {
    kind: 'compareOps';
    verdict: 'pass' | 'fail' | 'inconclusive';
    reason?: 'source_mismatch';
    checked: Partial<Record<keyof CompareOpsRules, boolean>>;
    violations: Array<{ metric: string; limit: number; actual: number; reason: string }>;
    ok: boolean;
    control: MeasureOpsResult;
    candidate: MeasureOpsResult;
}

/**
 * Run `fn(i)` `opts.ops` times with an optional `opts.warmup` prelude and
 * return per-op measurements plus the underlying summary. Sync-only in
 * v1.3.0; async functions have ambiguous per-op accounting.
 */
export function measureOps(fn: MeasureOpsFn, opts: MeasureOpsOptions): MeasureOpsResult;

/**
 * Gate a measureOps result against per-op rules. Returns the report; use
 * assertOps to throw on non-pass verdicts.
 */
export function checkOps(result: MeasureOpsResult, rules?: OpsRules): OpsGateResult;

/**
 * Measure and gate in one call. Throws GcBudgetError on fail,
 * GcInconclusiveError on inconclusive (unless opts.allowInconclusive).
 */
export function assertOps(fn: MeasureOpsFn, rules: OpsRules, opts: MeasureOpsOptions): OpsGateResult;

/**
 * Compare two measureOps results. Convenience form accepts two functions
 * with matched `opts` -- runs measureOps internally. Source mismatch between
 * control and candidate yields inconclusive with reason 'source_mismatch'.
 */
export function compareOps(
    control: MeasureOpsResult,
    candidate: MeasureOpsResult,
    rules?: CompareOpsRules
): CompareOpsResult;
export function compareOps(
    controlFn: MeasureOpsFn,
    candidateFn: MeasureOpsFn,
    rules: CompareOpsRules,
    opts: MeasureOpsOptions
): CompareOpsResult;

/** Assert form of compareOps. Same throw semantics as assertOps. */
export function assertCompareOps(
    control: MeasureOpsResult,
    candidate: MeasureOpsResult,
    rules?: CompareOpsRules
): CompareOpsResult;
export function assertCompareOps(
    controlFn: MeasureOpsFn,
    candidateFn: MeasureOpsFn,
    rules: CompareOpsRules,
    opts: MeasureOpsOptions
): CompareOpsResult;
