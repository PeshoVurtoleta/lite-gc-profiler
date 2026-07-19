export const VERSION: '1.8.0';

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
     *
     * Since v1.5.2 keys are created with `Object.defineProperty`, so a phase
     * named `__proto__` lands as a real own key instead of setting the
     * snapshot's prototype and vanishing from Object.keys/JSON.stringify.
     * The prototype is unchanged: reads, iteration, spreads, JSON.stringify,
     * deepStrictEqual and hasOwnProperty all behave as they always did.
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
     *
     * Keys defined with defineProperty since v1.5.2, as for `phases`.
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
    /**
     * @param capacity Pause-ring capacity. Default 256. Rounded up to the next
     * power of two. Must be a positive finite number no greater than
     * MAX_RING_CAPACITY (2**24 = 16,777,216; the ring costs 16 bytes/slot, so
     * the ceiling is already 256 MB). Values past the ceiling throw
     * RangeError -- before v1.5.2, capacities above 2**30 hung the process in
     * an infinite loop and large ones below it were a silent resource bomb.
     */
    constructor(capacity?: number, options?: GcProfilerOptions);

    readonly supported: boolean;
    readonly source: GcSource;
    readonly running: boolean;
    readonly gcCount: number;
    readonly majorCount: number;
    readonly minorCount: number;

    /**
     * Attach the perf_hooks GC observer (node). No-op where 'gc' entries are
     * unsupported.
     *
     * start() is a hard cutoff (v1.5.2): entries whose startTime precedes the
     * start() call are excluded even if node delivers them afterwards. Sync
     * GC-heavy code blocks the event loop and queues its 'gc' entries for
     * dispatch; before the cutoff, a profiler started later in the same turn
     * inherited that backlog, so a zero-GC gate over genuinely quiet code
     * falsely failed. An entry that began before start() is excluded even if
     * it finished after.
     */
    start(): this;
    /** Detach the observer. Also a hard cutoff, symmetric with start(). */
    stop(): this;

    /**
     * Inject a GC event directly (tests, or a custom source).
     * `startTime` defaults to performance.now(); pass explicit values to inject
     * events into specific phases deterministically.
     */
    /**
     * Inject a synthetic GC event. This is the test surface: `startTime` is
     * arbitrary and deliberately exempt from the start()/reset() observation
     * cutoff that applies to the observer path.
     *
     * `durationMs` must be a finite number >= 0 and `startTime`, when given,
     * must be finite -- both throw `RangeError` otherwise. Before v1.5.2 a
     * negative duration decremented the running total (producing maxMs > totalMs
     * and a negative avgMs), and Infinity poisoned totalMs/avgMs to non-finite
     * for every later read.
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

    /**
     * Clear all counters and start a fresh window. Also advances the
     * observation floor (v1.5.2): 'gc' entries recorded before reset() but
     * still queued for dispatch cannot repopulate the cleared counters.
     */
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
    /**
     * Populated on inconclusive.
     *   'invalid_baseline'       -- missing or wrong-schema baseline.
     *   'fingerprint_mismatch'   -- machine/runtime differs and
     *                               acceptFingerprintMismatch was not set.
     *   'no_comparable_metrics'  -- (v1.5.2) nothing could be verified: the
     *                               baseline and aggregate share no finite
     *                               metric pair. Previously reported 'pass'.
     */
    reason?: 'invalid_baseline' | 'fingerprint_mismatch' | 'no_comparable_metrics' | (string & {});
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
    /** GcProfiler pause-ring capacity. Default 256. Positive integer <= 2**24 (MAX_RING_CAPACITY); larger values throw RangeError. */
    capacity?: number;
    /**
     * Force a full GC at each steady-phase boundary so `bytesPerOp` reflects
     * the surviving-allocation delta (retention) rather than transient
     * allocation. Requires node --expose-gc; throws RangeError otherwise.
     * Adds a `stabilize` phase to the summary shape. Recommended for
     * cold-CI zero-alloc gates; see README for guidance. Default false.
     */
    stabilize?: boolean;
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

// =============================================================================
// Batch 7 (v1.4.0) -- per-frame primitives (G17/G18).
// =============================================================================

export type MeasureFramesFn = (i: number) => unknown | Promise<unknown>;

/** Scheduler abstraction. A function that schedules `cb` and returns any handle. */
export type FrameScheduler = (cb: () => void) => unknown;

/** Named scheduler strings or the escape-hatch function form. */
export type FrameSchedulerOpt = 'auto' | 'raf' | 'polyfill' | FrameScheduler;

/** Per-frame rules gated by checkFrames / assertFrames. All optional. */
export interface FramesRules {
    /** Retained bytes per frame (LSQ retention slope). Requires memory channel. */
    maxBytesPerFrame?: number;
    /** Major GC events per 1000 frames. Requires source='gc'. */
    maxMajorsPerKFrame?: number;
    /** Minor GC events per 1000 frames. Requires source='gc'. */
    maxMinorsPerKFrame?: number;
    /** Max GC pause observed in steady phase (ms). Requires source='gc'. */
    maxPauseMsPerFrame?: number;
    /**
     * Frames whose work-time exceeded frameBudgetMs. Source-agnostic --
     * measured directly from performance.now(), works on any source.
     */
    maxDroppedFrames?: number;
}

/** Delta rules for compareFrames / assertCompareFrames. */
export interface CompareFramesRules {
    maxExtraBytesPerFrame?: number;
    maxExtraDroppedFrames?: number;
}

/** Options for measureFrames. */
export interface MeasureFramesOptions {
    /** Steady-phase frame count. Required, positive integer. */
    frames: number;
    /** Warmup frames, excluded from steady stats. Default 0. */
    warmup?: number;
    /**
     * Scheduler choice. 'auto' (default) prefers requestAnimationFrame,
     * falls back to a self-correcting setTimeout polyfill. Function form
     * is the escape hatch for deterministic tests.
     */
    scheduler?: FrameSchedulerOpt;
    /** Work-time threshold for droppedFrames (ms). Default 1000/60 ≈ 16.67. */
    frameBudgetMs?: number;
    /** Source selection. Default 'auto'. */
    source?: 'auto' | 'gc' | 'heap' | 'uasm' | 'none';
    /** GcProfiler pause-ring capacity. Default 256. Positive integer <= 2**24 (MAX_RING_CAPACITY); larger values throw RangeError. */
    capacity?: number;
    /**
     * Force a full GC at each steady boundary so bytesPerFrame reflects the
     * retained live-set delta rather than the raw heapUsed climb (which a
     * per-frame scheduler's transient churn inflates). Requires
     * globalThis.gc (node --expose-gc).
     *   - undefined (default): auto -- stabilize when globalThis.gc exists,
     *     otherwise fall back to the slope estimate.
     *   - true: demand stabilization; reject if globalThis.gc is unavailable.
     *   - false: never force GC; use the slope estimate (bytesPerFrameStable
     *     will be false).
     */
    stabilize?: boolean;
    /**
     * When true, checkFrames returns the report even with inconclusive
     * verdict instead of throwing. Only meaningful for assertFrames /
     * assertCompareFrames.
     */
    allowInconclusive?: boolean;
}

/** Result of a measureFrames run. */
export interface FramesResult {
    schema: 'lite-gc-frames/1';
    frames: number;
    warmupFrames: number;
    /** Wall-clock elapsed during steady phase (ms). */
    elapsedMs: number;
    /** Effective frames-per-second during steady. */
    fps: number;
    /**
     * Retained bytes per steady frame. When stabilized (see options), this is
     * the post-GC live-set delta across the steady window: clean workloads
     * read ~0 (down to a small V8 live-set jitter floor) and real leaks read
     * their true rate, stable across cold/warm runs. Unstabilized, it is a
     * best-effort retention-slope estimate carrying a noise floor -- see
     * bytesPerFrameStable. For tight leak gating below the absolute floor, use
     * compareFrames / maxExtraBytesPerFrame, which cancels the floor.
     * null on source='none' or source='auto' + memory unavailable.
     */
    bytesPerFrame: number | null;
    /**
     * True when bytesPerFrame was GC-anchored (stabilized) and is therefore a
     * trustworthy retained-bytes figure; false when it is the slope estimate
     * (no forceable GC / stabilize:false).
     */
    bytesPerFrameStable: boolean;
    majorsPerKFrame: number;
    minorsPerKFrame: number;
    maxPauseMsPerFrame: number;
    droppedFrames: number;
    frameTimes: { p50: number; p95: number; p99: number; max: number };
    /**
     * Bytes the heap grew AFTER gc.settle() returned. Non-zero signals
     * fire-and-forget work outliving the measurement window. Smoke
     * detector, not a gate rule.
     */
    asyncResidual: number;
    source: 'gc' | 'heap' | 'uasm' | 'none';
    summary: GcSummary;
}

/** Result of checkFrames / assertFrames / compareFrames / assertCompareFrames. */
export interface FramesGateResult {
    schema: 'lite-gc-report/1';
    kind: 'frames';
    verdict: 'pass' | 'fail' | 'inconclusive';
    source: 'gc' | 'heap' | 'uasm' | 'none';
    violations: Array<{ rule: string; metric: string; actual: number; limit: number }>;
    checked: Record<string, boolean>;
    result?: FramesResult;
    control?: FramesResult;
    candidate?: FramesResult;
    reason?: string;
}

export function measureFrames(fn: MeasureFramesFn, opts: MeasureFramesOptions): Promise<FramesResult>;
export function checkFrames(result: FramesResult, rules: FramesRules): FramesGateResult;
export function assertFrames(
    fn: MeasureFramesFn,
    rules: FramesRules,
    opts: MeasureFramesOptions
): Promise<FramesGateResult>;
export function compareFrames(
    control: FramesResult,
    candidate: FramesResult,
    rules: CompareFramesRules
): Promise<FramesGateResult>;
export function compareFrames(
    controlFn: MeasureFramesFn,
    candidateFn: MeasureFramesFn,
    rules: CompareFramesRules,
    opts: MeasureFramesOptions
): Promise<FramesGateResult>;
export function assertCompareFrames(
    control: FramesResult,
    candidate: FramesResult,
    rules: CompareFramesRules
): Promise<FramesGateResult>;
export function assertCompareFrames(
    controlFn: MeasureFramesFn,
    candidateFn: MeasureFramesFn,
    rules: CompareFramesRules,
    opts: MeasureFramesOptions
): Promise<FramesGateResult>;

// =============================================================================
// Batch 8 (v1.5.0) -- serialized async ops (G19).
// =============================================================================

export type MeasureOpsAsyncFn = (i: number) => unknown | Promise<unknown>;

/** Options for measureOpsAsync. */
export interface MeasureOpsAsyncOptions {
    /** Steady op count. Required, positive integer. */
    ops: number;
    /** Warmup ops, excluded from steady stats. Default 0. */
    warmup?: number;
    /** Source selection. Default 'auto'. */
    source?: 'auto' | 'gc' | 'heap' | 'uasm' | 'none';
    /** GcProfiler pause-ring capacity. Default 256. Positive integer <= 2**24 (MAX_RING_CAPACITY); larger values throw RangeError. */
    capacity?: number;
    /**
     * When true, forces a full GC at each steady boundary so bytesPerOp
     * reflects the retained-bytes rate rather than a raw two-point delta.
     * Defaults to true when globalThis.gc is available (node --expose-gc);
     * defaults to false otherwise. Setting explicitly to true without a
     * forceable GC throws a RangeError.
     */
    stabilize?: boolean;
    /**
     * When true, assertOpsAsync / assertCompareOpsAsync returns
     * inconclusive reports instead of throwing GcInconclusiveError.
     */
    allowInconclusive?: boolean;
}

/** Rules for checkOpsAsync / assertOpsAsync. Same vocabulary as ops. */
export interface OpsAsyncRules {
    /** Retained bytes per op. Requires memory channel. */
    maxBytesPerOp?: number;
    /** Major GC events per 1000 ops. Requires source='gc'. */
    maxMajorsPerKOp?: number;
    /** Minor GC events per 1000 ops. Requires source='gc'. */
    maxMinorsPerKOp?: number;
    /** Max GC pause observed in steady phase (ms). Requires source='gc'. */
    maxPauseMsPerOp?: number;
}

/** Delta rules for compareOpsAsync / assertCompareOpsAsync. */
export interface CompareOpsAsyncRules {
    maxExtraBytesPerOp?: number;
    maxExtraMajorsPerKOp?: number;
    maxExtraMinorsPerKOp?: number;
    maxExtraPauseMsPerOp?: number;
}

/** Result of a measureOpsAsync run. */
export interface OpsAsyncResult {
    schema: 'lite-gc-ops-async/1';
    ops: number;
    warmupOps: number;
    elapsedMs: number;
    opsPerSec: number;
    /**
     * Retained bytes per op. Stabilized path (default under --expose-gc):
     * live-set delta at forced-GC boundaries. Fallback (no forceable GC):
     * raw two-point delta. null on source='none' or memory unavailable.
     */
    bytesPerOp: number | null;
    /** True if the stabilized live-set-delta path ran; false otherwise. */
    bytesPerOpStable: boolean;
    majorsPerKOp: number;
    minorsPerKOp: number;
    maxPauseMsPerOp: number;
    /** Bytes heap grew AFTER gc.settle(). Smoke detector for fire-and-forget work. */
    asyncResidual: number;
    source: 'gc' | 'heap' | 'uasm' | 'none';
    summary: GcSummary;
}

/** Result of checkOpsAsync / assertOpsAsync / compareOpsAsync / assertCompareOpsAsync. */
export interface OpsAsyncGateResult {
    schema: 'lite-gc-report/1';
    kind: 'ops-async';
    verdict: 'pass' | 'fail' | 'inconclusive';
    source: 'gc' | 'heap' | 'uasm' | 'none';
    violations: Array<{ rule: string; metric: string; actual: number; limit: number }>;
    checked: Record<string, boolean>;
    result?: OpsAsyncResult;
    control?: OpsAsyncResult;
    candidate?: OpsAsyncResult;
    reason?: string;
}

export function measureOpsAsync(
    fn: MeasureOpsAsyncFn,
    opts: MeasureOpsAsyncOptions
): Promise<OpsAsyncResult>;

export function checkOpsAsync(
    result: OpsAsyncResult,
    rules: OpsAsyncRules
): OpsAsyncGateResult;

export function assertOpsAsync(
    fn: MeasureOpsAsyncFn,
    rules: OpsAsyncRules,
    opts: MeasureOpsAsyncOptions
): Promise<OpsAsyncGateResult>;

export function compareOpsAsync(
    control: OpsAsyncResult,
    candidate: OpsAsyncResult,
    rules: CompareOpsAsyncRules
): Promise<OpsAsyncGateResult>;
export function compareOpsAsync(
    controlFn: MeasureOpsAsyncFn,
    candidateFn: MeasureOpsAsyncFn,
    rules: CompareOpsAsyncRules,
    opts: MeasureOpsAsyncOptions
): Promise<OpsAsyncGateResult>;

export function assertCompareOpsAsync(
    control: OpsAsyncResult,
    candidate: OpsAsyncResult,
    rules: CompareOpsAsyncRules
): Promise<OpsAsyncGateResult>;
export function assertCompareOpsAsync(
    controlFn: MeasureOpsAsyncFn,
    candidateFn: MeasureOpsAsyncFn,
    rules: CompareOpsAsyncRules,
    opts: MeasureOpsAsyncOptions
): Promise<OpsAsyncGateResult>;

// =============================================================================
// Batch 10 (v1.7.0) -- multi-context aggregation (G22).
// =============================================================================

/**
 * A single per-context measurement used as input to aggregateWorkerReports.
 * The minimum required shape is a subset of what measureOps / measureOpsAsync
 * produce -- .ops, .source, and any subset of the numeric rate/pause fields.
 * Missing numeric fields are treated as zero for rate accumulation.
 */
export interface WorkerReport {
    /** Steady-phase op count for this context. Must be a positive finite number. */
    ops: number;
    /** Source label -- must be a string. Values that don't match across contexts yield 'mixed'. */
    source: string;
    /** null on source='none' or memory-unavailable; propagates to the aggregate. */
    bytesPerOp?: number | null;
    /** true iff the context ran the stabilised (forced-GC boundary) path. Missing = treat as non-degrading. */
    bytesPerOpStable?: boolean;
    majorsPerKOp?: number;
    minorsPerKOp?: number;
    maxPauseMsPerOp?: number;
    /** Optional GC summary; carried through to perContext but not aggregated. */
    summary?: GcSummary;
}

/** Aggregate metrics derived from N per-context reports. */
export interface AggregatedOpsMetrics {
    source: string;
    totalOps: number;
    /** null if any per-context bytesPerOp was null or non-finite. */
    bytesPerOp: number | null;
    /**
     * Logical AND across contexts. false if any context reported false, and
     * also false when the set is MIXED -- some contexts reporting the flag and
     * others omitting it -- because absence there is unknown provenance rather
     * than confirmed stability. An all-legacy set (no context reports it) has
     * nothing to degrade and stays true.
     */
    bytesPerOpStable: boolean;
    /**
     * Ops-weighted rate: (total events across contexts / total ops) * 1000.
     *
     * null if ANY context omitted the metric or reported it non-finite. A
     * context's ops count lands in the denominator regardless, so treating an
     * absent metric as a zero contribution would dilute the aggregate toward
     * clean and gate green on something never measured -- notably for
     * `measureOps` results, which carry no GC rates at all because the
     * synchronous lane cannot observe GC events.
     */
    majorsPerKOp: number | null;
    minorsPerKOp: number | null;
    /** MAX across contexts -- the worst pause anywhere. null if any context omitted it. */
    maxPauseMsPerOp: number | null;
}

export interface WorkerAggregateResult {
    schema: 'lite-gc-ops-multi/1';
    kind: 'ops-multi';
    contexts: number;
    aggregate: AggregatedOpsMetrics;
    perContext: WorkerReport[];
}

export interface WorkerAggregateOptions {
    /** Optional label for the aggregate. Not used in the returned shape yet. */
    label?: string;
}

/**
 * Aggregate an array of per-context ops measurement results into a single
 * multi-context report. Pure aggregation -- no measurement, no observer, no
 * perturbation. Users bring their own workers (node:worker_threads, browser
 * Web Workers via @zakkster/lite-worker or a hand-rolled Blob URL, etc.) and
 * hand the per-context results here.
 */
export function aggregateWorkerReports(
    reports: WorkerReport[],
    opts?: WorkerAggregateOptions
): WorkerAggregateResult;

/**
 * Gate an aggregate report against per-op rules. Same rule vocabulary as
 * checkOps -- maxBytesPerOp, maxMajorsPerKOp, maxMinorsPerKOp,
 * maxPauseMsPerOp. If contexts ran on different sources ('mixed'), the
 * verdict is inconclusive with reason='source_mismatch'.
 */
export function checkAggregateReport(
    multiReport: WorkerAggregateResult,
    rules: OpsRules
): GcReport;

/**
 * Convenience: aggregateWorkerReports + checkAggregateReport, throwing
 * GcBudgetError on fail or GcInconclusiveError on inconclusive (unless
 * opts.allowInconclusive).
 */
export function assertAggregateReport(
    reports: WorkerReport[],
    rules: OpsRules,
    opts?: { allowInconclusive?: boolean }
): GcReport;

// =============================================================================
// Batch 11 (v1.8.0) -- multi-context frame aggregation (G23).
// =============================================================================

/**
 * A single per-context frames measurement used as input to
 * aggregateFrameReports. The minimum required shape is a subset of
 * what measureFrames produces -- .frames, .source, and any subset of
 * the numeric rate/pause/drop fields.
 */
export interface FramesReport {
    /** Steady-phase frame count for this context. Must be a positive finite number. */
    frames: number;
    /** Source label -- must be a string. Values that don't match across contexts yield 'mixed'. */
    source: string;
    /** null on source='none' or memory-unavailable; propagates to the aggregate. */
    bytesPerFrame?: number | null;
    /** true iff the context ran the stabilised (forced-GC boundary) path. */
    bytesPerFrameStable?: boolean;
    majorsPerKFrame?: number;
    minorsPerKFrame?: number;
    maxPauseMsPerFrame?: number;
    droppedFrames?: number;
    asyncResidual?: number;
    /**
     * Per-context frameTimes are preserved in perContext[i] but NOT
     * carried into the aggregate. Percentiles are not compositional.
     */
    frameTimes?: { p50: number; p95: number; p99: number; max: number };
    summary?: GcSummary;
}

/** Aggregate metrics derived from N per-context frames reports. */
export interface AggregatedFramesMetrics {
    source: string;
    totalFrames: number;
    /** null if any per-context bytesPerFrame was null or non-finite. */
    bytesPerFrame: number | null;
    /**
     * true only when no context reported false AND (all contexts
     * reported the flag OR none did). A mixed presence/absence set
     * yields false -- unknown provenance from silent contexts.
     */
    bytesPerFrameStable: boolean;
    /** null if any context omitted or reported non-finite. Dilution guard. */
    majorsPerKFrame: number | null;
    /** null if any context omitted or reported non-finite. */
    minorsPerKFrame: number | null;
    /** null if any context omitted or reported non-finite. */
    maxPauseMsPerFrame: number | null;
    /** SUM across contexts; null if any context omitted. */
    droppedFrames: number | null;
    /**
     * SUM across contexts. An ABSENT value counts as zero -- a lane that does
     * not track residual has none by definition, and this is a smoke signal
     * rather than a gated metric, so absence should not poison the total.
     *
     * A PRESENT but non-finite value is different: that context's residual
     * reading broke. Folding it in as zero made the aggregate under-report
     * exactly when something was wrong, so it yields null instead.
     */
    asyncResidual: number | null;
}

export interface FramesAggregateResult {
    schema: 'lite-gc-frames-multi/1';
    kind: 'frames-multi';
    contexts: number;
    aggregate: AggregatedFramesMetrics;
    perContext: FramesReport[];
}

export interface FramesAggregateOptions {
    /** Optional label for the aggregate. */
    label?: string;
}

/** Rules for checkAggregateFramesReport. Same vocabulary as checkFrames. */
export interface FramesRules {
    maxBytesPerFrame?: number;
    maxMajorsPerKFrame?: number;
    maxMinorsPerKFrame?: number;
    maxPauseMsPerFrame?: number;
    maxDroppedFrames?: number;
}

/**
 * Aggregate an array of per-context frames measurement results into a
 * single multi-context report. Pure aggregation -- no spawning, no
 * messaging, no perturbation. Users bring their own workers.
 *
 * Weighted-by-frames rates; MAX for pause; SUM for droppedFrames and
 * asyncResidual; logical AND with provenance for stability;
 * dilution guard on all rate metrics (missing on any context -> null
 * on aggregate). frameTimes deliberately absent -- percentiles are
 * not compositional.
 */
export function aggregateFrameReports(
    reports: FramesReport[],
    opts?: FramesAggregateOptions
): FramesAggregateResult;

/**
 * Gate a frames aggregate against per-frame rules. Same rule
 * vocabulary as checkFrames. Mixed sources return inconclusive with
 * reason='source_mismatch'.
 */
export function checkAggregateFramesReport(
    multiReport: FramesAggregateResult,
    rules: FramesRules
): GcReport;

/**
 * Convenience: aggregateFrameReports + checkAggregateFramesReport,
 * throwing on fail or inconclusive (unless allowInconclusive).
 */
export function assertAggregateFramesReport(
    reports: FramesReport[],
    rules: FramesRules,
    opts?: { allowInconclusive?: boolean }
): GcReport;
