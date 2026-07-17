// @zakkster/lite-gc-profiler
// Zero-dependency GC and heap profiler. It exists to make the zero-GC claim
// falsifiable rather than asserted.
//
//   node    -> precise: perf_hooks 'gc' entries (kind + pause duration).
//   Chrome  -> heuristic: performance.memory heap sampling (alloc rate, drops).
//   others  -> long-frame anomaly detection only (no heap API).
//
// The observer receives node-allocated entry lists between frames; the per-frame
// methods (sampleHeap, markFrame) allocate nothing.

const VERSION = '1.4.0';

// V8 GC kind constants (perf_hooks NODE_PERFORMANCE_GC_*).
const GC_MINOR = 1;         // Scavenge (young generation)
const GC_MAJOR = 4;         // Mark-Sweep-Compact (full heap) -- the pressure signal
const GC_INCREMENTAL = 8;   // incremental marking step
const GC_WEAKCB = 16;       // weak callback processing

const GC_SUPPORTED = typeof PerformanceObserver !== 'undefined'
    && Array.isArray(PerformanceObserver.supportedEntryTypes)
    && PerformanceObserver.supportedEntryTypes.indexOf('gc') !== -1;

function readHeapUsed() {
    if (typeof performance !== 'undefined' && performance.memory
        && typeof performance.memory.usedJSHeapSize === 'number') {
        return performance.memory.usedJSHeapSize;
    }
    return -1;
}
const HEAP_SUPPORTED = readHeapUsed() >= 0;

// Chrome's accurate but async memory measurement API. Requires cross-origin
// isolation (COOP + COEP headers) to be exposed. Coarse and slow -- not for
// per-frame use. Users opt in explicitly via `new GcProfiler(cap, { source: 'uasm' })`;
// auto-detection never picks it because cross-origin isolation is a
// deployment choice, not a runtime property to silently follow.
const UASM_SUPPORTED = typeof performance !== 'undefined'
    && typeof performance.measureUserAgentSpecificMemory === 'function'
    && typeof globalThis !== 'undefined'
    && globalThis.crossOriginIsolated === true;

function pow2(n) { let p = 1; while (p < n) p <<= 1; return p < 1 ? 1 : p; }

// Fixed capacities for the phase subsystem. Both throw on overflow rather than
// silently drop -- silent overflow of a gating primitive is the class of bug G1
// closed, and this is not the place to re-open it. Raise here if real usage
// ever hits either limit.
const MAX_PHASES = 32;
const MAX_BOUNDARIES = 1024;

// Region subsystem (G10). Regions nest -- a stack of currently-active regions
// is maintained; enter pushes, exit pops. GC events attribute to the innermost
// containing interval by startTime. Same overflow discipline as phases.
const MAX_REGIONS = 32;
const MAX_REGION_STACK_DEPTH = 16;
const MAX_REGION_INTERVALS = 2048;

// Minimal in-place ring for the pause-duration percentile window.
class DurationRing {
    constructor(cap) {
        this.cap = pow2(cap); this.mask = this.cap - 1;
        this.buf = new Float64Array(this.cap); this.head = 0; this.len = 0;
    }
    push(v) { this.buf[this.head] = v; this.head = (this.head + 1) & this.mask; if (this.len < this.cap) this.len++; }
    clear() { this.head = 0; this.len = 0; }
}

// Nearest-rank percentile over the ring's valid values, using a preallocated scratch.
function percentile(ring, scratch, q) {
    const n = ring.len;
    if (n === 0) return 0;
    for (let i = 0; i < n; i++) scratch[i] = ring.buf[i];   // order is irrelevant; we sort
    const view = scratch.subarray(0, n);
    view.sort();
    let idx = Math.ceil(q * n) - 1;
    if (idx < 0) idx = 0; else if (idx > n - 1) idx = n - 1;
    return view[idx];
}

class GcProfiler {
    /**
     * @param {number} capacity  size of the pause-duration percentile window (rounded up to a power of two).
     * @param {{ heap?: boolean, autoStart?: boolean, source?: 'auto' | 'gc' | 'heap' | 'uasm' | 'none' }} [options]
     *   source:
     *     'auto' (default) -- detect: 'gc' on node, 'heap' on Chrome, 'none' otherwise.
     *     'uasm'           -- opt into performance.measureUserAgentSpecificMemory as the
     *                         primary gate channel. Throws if the API is unavailable or
     *                         the page is not cross-origin-isolated. Never auto-selected.
     *     other explicit   -- override auto-detection.
     */
    constructor(capacity = 256, options = {}) {
        if (!(capacity > 0) || !isFinite(capacity)) {
            throw new RangeError('GcProfiler: capacity must be a positive finite number');
        }

        // Source resolution. 'auto' (default) follows the historical detection.
        // Explicit source overrides it; 'uasm' is validated -- silently falling
        // through to 'none' would defeat the point of asking for it.
        const requested = options.source || 'auto';
        if (requested !== 'auto' && requested !== 'gc' && requested !== 'heap' && requested !== 'uasm' && requested !== 'none') {
            throw new RangeError("GcProfiler: source must be one of 'auto', 'gc', 'heap', 'uasm', 'none'");
        }
        if (requested === 'uasm' && !UASM_SUPPORTED) {
            throw new RangeError('GcProfiler: source=uasm requires performance.measureUserAgentSpecificMemory and crossOriginIsolated');
        }
        this._source = requested;                                      // 'auto' resolved lazily in the getter

        this._dur = new DurationRing(capacity);
        this._scratch = new Float64Array(this._dur.cap);

        this._count = 0; this._sumMs = 0; this._maxMs = 0;
        this._minor = 0; this._major = 0; this._incremental = 0; this._weakcb = 0;

        // heap sampling (browser, or explicit usedBytes elsewhere)
        this._heapActive = false;
        this._heapPrev = -1; this._heapPeak = 0; this._heapFirst = -1; this._heapSamples = 0;
        this._allocBytes = 0; this._gcDrops = 0; this._freedBytes = 0;
        this._tPrev = -1; this._elapsedMs = 0;

        // uasm sampling (G12). Populated by sampleUasm() calls; independent
        // of heap sampling -- both can run concurrently on a cross-origin-
        // isolated Chrome page. Always present in summary; supported:false
        // and zeros when the API is unavailable.
        this._uasmBytes = 0; this._uasmPeak = 0; this._uasmFirst = -1; this._uasmSamples = 0;
        this._uasmT0 = -1; this._uasmTPrev = -1;

        // frame anomaly heuristic
        this._frames = 0; this._longFrames = 0; this._frameEwma = 0;

        // Phase attribution. Boundaries are (time, phaseIdx) pairs appended in
        // chronological order; a GC event with startTime t is bucketed into the
        // phase whose boundary is the last <= t. Per-phase counters mirror the
        // global gc-stat shape but omit p99Ms (would require a ring per phase).
        this._phaseNames = [];
        this._phaseIndex = new Map();
        this._phaseIdxCount = 0;
        this._currentPhaseIdx = -1;                                    // -1 means "before any phase() call"
        this._boundaryTimes = new Float64Array(MAX_BOUNDARIES);
        this._boundaryPhases = new Int32Array(MAX_BOUNDARIES);
        this._boundaryCount = 0;
        this._phaseCount = new Uint32Array(MAX_PHASES);
        this._phaseSumMs = new Float64Array(MAX_PHASES);
        this._phaseMaxMs = new Float64Array(MAX_PHASES);
        this._phaseMinor = new Uint32Array(MAX_PHASES);
        this._phaseMajor = new Uint32Array(MAX_PHASES);
        this._phaseIncremental = new Uint32Array(MAX_PHASES);
        this._phaseWeakcb = new Uint32Array(MAX_PHASES);

        // Region attribution (G10). Regions nest; a stack tracks currently-active
        // regions. Each enter opens an interval, each exit closes it. GC events
        // attribute to the innermost open interval containing the event's
        // startTime. Events outside all intervals go to an "unattributed" bucket.
        //
        // Attribution is FIRING-SITE, not allocator. V8 collects when allocation
        // debt crosses a threshold; the debtor may be a prior region. The
        // firing-site is still the right first filter -- the allocator question
        // is what explain mode (G11) answers separately.
        this._regionNames = [];
        this._regionIndex = new Map();
        this._regionIdxCount = 0;
        this._regionStack = new Int32Array(MAX_REGION_STACK_DEPTH);
        this._regionStackDepth = 0;
        // Interval ring: parallel arrays. exitTime = 0 means "still open".
        this._regionIntervalRegionIdx = new Int32Array(MAX_REGION_INTERVALS);
        this._regionIntervalEnterTime = new Float64Array(MAX_REGION_INTERVALS);
        this._regionIntervalExitTime = new Float64Array(MAX_REGION_INTERVALS);
        // For each interval, the position in the intervals array of the containing
        // interval (its immediate parent), or -1 if top-level. Used to accelerate
        // innermost-at-time lookup during attribution.
        this._regionIntervalParent = new Int32Array(MAX_REGION_INTERVALS);
        this._regionIntervalCount = 0;
        // Per-region counters, indexed by regionIdx. Mirror the phase counters.
        this._regionCount = new Uint32Array(MAX_REGIONS);
        this._regionSumMs = new Float64Array(MAX_REGIONS);
        this._regionMaxMs = new Float64Array(MAX_REGIONS);
        this._regionMinor = new Uint32Array(MAX_REGIONS);
        this._regionMajor = new Uint32Array(MAX_REGIONS);
        this._regionIncremental = new Uint32Array(MAX_REGIONS);
        this._regionWeakcb = new Uint32Array(MAX_REGIONS);
        // Unattributed bucket (events outside any region).
        this._regionUnattrCount = 0;
        this._regionUnattrSumMs = 0;
        this._regionUnattrMaxMs = 0;
        this._regionUnattrMinor = 0;
        this._regionUnattrMajor = 0;
        this._regionUnattrIncremental = 0;
        this._regionUnattrWeakcb = 0;

        this._obs = null; this._running = false;
        this._wantHeap = options.heap !== false;
        // Batch counter for settle(): incremented once per observer callback,
        // regardless of how many entries the batch contained. Settle uses it as
        // the "did anything just arrive?" signal without touching the hot path
        // beyond a single integer increment.
        this._batchCount = 0;
        if (options.autoStart) this.start();
    }

    get supported() { return GC_SUPPORTED || HEAP_SUPPORTED || UASM_SUPPORTED; }
    /**
     * Which signal is live: 'gc' (precise, node), 'heap' (Chrome heuristic),
     * 'uasm' (Chrome accurate, opt-in), or 'none'. Honors the explicit
     * constructor option; 'auto' follows historical detection (gc | heap | none).
     */
    get source() {
        if (this._source !== 'auto') return this._source;
        return GC_SUPPORTED ? 'gc' : (HEAP_SUPPORTED ? 'heap' : 'none');
    }
    get running() { return this._running; }
    get gcCount() { return this._count; }
    get majorCount() { return this._major; }
    get minorCount() { return this._minor; }

    /** Attach the perf_hooks GC observer (node). No-op where 'gc' entries are unsupported. */
    start() {
        if (this._running) return this;
        if (!GC_SUPPORTED) { this._running = true; return this; }   // heap/none: nothing to attach
        const self = this;
        this._obs = new PerformanceObserver((list) => {
            const es = list.getEntries();
            for (let i = 0; i < es.length; i++) {
                const e = es[i];
                // node >=16 carries kind in entry.detail; older exposed e.kind directly.
                // Guard the object, not the expression: a null detail must fall through.
                const d = e.detail;
                const kind = (d && d.kind !== undefined) ? d.kind : e.kind;
                self._record(kind, e.duration, e.startTime);
            }
            self._batchCount++;
        });
        this._obs.observe({ entryTypes: ['gc'] });
        this._running = true;
        return this;
    }

    stop() {
        if (this._obs) { this._obs.disconnect(); this._obs = null; }
        this._running = false;
        return this;
    }

    _record(kind, durationMs, startTime) {
        this._dur.push(durationMs);
        this._count++; this._sumMs += durationMs;
        if (durationMs > this._maxMs) this._maxMs = durationMs;
        if (kind === GC_MINOR) this._minor++;
        else if (kind === GC_MAJOR) this._major++;
        else if (kind === GC_INCREMENTAL) this._incremental++;
        else if (kind === GC_WEAKCB) this._weakcb++;

        // Phase attribution. Events with startTime before the first phase boundary
        // (or when no phases have been declared) are counted globally but not
        // attributed to any phase -- an event outside any declared phase is not
        // part of a phase claim, so no phase should be charged for it.
        if (this._boundaryCount > 0) {
            let phaseIdx = -1;
            for (let i = this._boundaryCount - 1; i >= 0; i--) {
                if (this._boundaryTimes[i] <= startTime) { phaseIdx = this._boundaryPhases[i]; break; }
            }
            if (phaseIdx >= 0) {
                this._phaseCount[phaseIdx]++;
                this._phaseSumMs[phaseIdx] += durationMs;
                if (durationMs > this._phaseMaxMs[phaseIdx]) this._phaseMaxMs[phaseIdx] = durationMs;
                if (kind === GC_MINOR) this._phaseMinor[phaseIdx]++;
                else if (kind === GC_MAJOR) this._phaseMajor[phaseIdx]++;
                else if (kind === GC_INCREMENTAL) this._phaseIncremental[phaseIdx]++;
                else if (kind === GC_WEAKCB) this._phaseWeakcb[phaseIdx]++;
            }
        }

        // Region attribution. Walk intervals backward to find the innermost one
        // whose enterTime <= startTime <= (exitTime or Infinity for open intervals).
        // "Innermost" is the most recently entered among containing intervals;
        // walking backward from the last recorded interval finds it first.
        if (this._regionIntervalCount > 0) {
            let regionIdx = -1;
            for (let i = this._regionIntervalCount - 1; i >= 0; i--) {
                const enterT = this._regionIntervalEnterTime[i];
                if (enterT > startTime) continue;
                const exitT = this._regionIntervalExitTime[i];
                if (exitT > 0 && exitT < startTime) continue;
                regionIdx = this._regionIntervalRegionIdx[i];
                break;
            }
            if (regionIdx >= 0) {
                this._regionCount[regionIdx]++;
                this._regionSumMs[regionIdx] += durationMs;
                if (durationMs > this._regionMaxMs[regionIdx]) this._regionMaxMs[regionIdx] = durationMs;
                if (kind === GC_MINOR) this._regionMinor[regionIdx]++;
                else if (kind === GC_MAJOR) this._regionMajor[regionIdx]++;
                else if (kind === GC_INCREMENTAL) this._regionIncremental[regionIdx]++;
                else if (kind === GC_WEAKCB) this._regionWeakcb[regionIdx]++;
            } else {
                // Event fell outside all intervals -- unattributed bucket.
                this._regionUnattrCount++;
                this._regionUnattrSumMs += durationMs;
                if (durationMs > this._regionUnattrMaxMs) this._regionUnattrMaxMs = durationMs;
                if (kind === GC_MINOR) this._regionUnattrMinor++;
                else if (kind === GC_MAJOR) this._regionUnattrMajor++;
                else if (kind === GC_INCREMENTAL) this._regionUnattrIncremental++;
                else if (kind === GC_WEAKCB) this._regionUnattrWeakcb++;
            }
        }
    }

    /**
     * Inject a GC event directly (tests, or a custom source).
     * `startTime` defaults to performance.now(); pass an explicit value to inject
     * events into specific phases deterministically.
     */
    record(kind, durationMs, startTime) {
        const t = startTime === undefined
            ? (typeof performance !== 'undefined' ? performance.now() : 0)
            : +startTime;
        this._record(kind | 0, +durationMs || 0, t);
        return this;
    }

    /**
     * Mark a phase boundary. Everything from this call until the next phase() call
     * (or the end of the measurement window) is attributed to `name`. Repeated calls
     * with the same current name are a no-op -- a phase does not re-enter itself.
     * Throws on invalid names or capacity exhaustion.
     */
    phase(name) {
        if (typeof name !== 'string' || name.length === 0) {
            throw new TypeError('GcProfiler.phase: name must be a non-empty string');
        }
        let idx = this._phaseIndex.get(name);
        if (idx === undefined) {
            if (this._phaseIdxCount >= MAX_PHASES) {
                throw new RangeError('GcProfiler.phase: max phases (' + MAX_PHASES + ') exceeded');
            }
            idx = this._phaseIdxCount++;
            this._phaseNames.push(name);
            this._phaseIndex.set(name, idx);
        }
        if (idx === this._currentPhaseIdx) return this;                // idempotent
        if (this._boundaryCount >= MAX_BOUNDARIES) {
            throw new RangeError('GcProfiler.phase: max boundaries (' + MAX_BOUNDARIES + ') exceeded');
        }
        const t = typeof performance !== 'undefined' ? performance.now() : 0;
        this._boundaryTimes[this._boundaryCount] = t;
        this._boundaryPhases[this._boundaryCount] = idx;
        this._boundaryCount++;
        this._currentPhaseIdx = idx;
        return this;
    }

    /**
     * Enter a region. Regions nest -- multiple regions can be active at once,
     * and enter/exit calls MUST pair (LIFO). The innermost open region is what
     * GC events attribute to.
     *
     * Attribution semantics: firing-site, not allocator. V8 collects when
     * allocation debt crosses a threshold; the debtor may be a prior region.
     * The firing-site is still the right first filter -- the allocator question
     * is what explain mode answers separately.
     *
     * @param {string} name  region name, interned on first use
     * @throws {TypeError}   if name is not a non-empty string
     * @throws {RangeError}  on capacity exhaustion (32 unique regions, 16 nesting, 2048 intervals)
     */
    enter(name) {
        if (typeof name !== 'string' || name.length === 0) {
            throw new TypeError('GcProfiler.enter: name must be a non-empty string');
        }
        let idx = this._regionIndex.get(name);
        if (idx === undefined) {
            if (this._regionIdxCount >= MAX_REGIONS) {
                throw new RangeError('GcProfiler.enter: max regions (' + MAX_REGIONS + ') exceeded');
            }
            idx = this._regionIdxCount++;
            this._regionNames.push(name);
            this._regionIndex.set(name, idx);
        }
        if (this._regionStackDepth >= MAX_REGION_STACK_DEPTH) {
            throw new RangeError('GcProfiler.enter: max region nesting depth (' + MAX_REGION_STACK_DEPTH + ') exceeded');
        }
        if (this._regionIntervalCount >= MAX_REGION_INTERVALS) {
            throw new RangeError('GcProfiler.enter: max intervals (' + MAX_REGION_INTERVALS + ') exceeded');
        }
        const t = typeof performance !== 'undefined' ? performance.now() : 0;
        const parent = this._regionStackDepth > 0
            ? this._regionStack[this._regionStackDepth - 1]
            : -1;
        // Push interval + push stack
        const ivIdx = this._regionIntervalCount;
        this._regionIntervalRegionIdx[ivIdx] = idx;
        this._regionIntervalEnterTime[ivIdx] = t;
        this._regionIntervalExitTime[ivIdx] = 0;                       // 0 = still open
        this._regionIntervalParent[ivIdx] = parent;
        this._regionIntervalCount++;
        this._regionStack[this._regionStackDepth] = ivIdx;
        this._regionStackDepth++;
        return this;
    }

    /**
     * Exit the innermost open region. LIFO pairing with enter().
     * @throws {RangeError} if called with no open region.
     */
    exit() {
        if (this._regionStackDepth === 0) {
            throw new RangeError('GcProfiler.exit: no open region to exit');
        }
        this._regionStackDepth--;
        const ivIdx = this._regionStack[this._regionStackDepth];
        const t = typeof performance !== 'undefined' ? performance.now() : 0;
        this._regionIntervalExitTime[ivIdx] = t;
        return this;
    }

    /**
     * Wait for the observer's delivery queue to drain. The GC observer receives
     * batches asynchronously, so calling summary() straight after work completes
     * can miss entries that fired but were not yet delivered. settle() polls a
     * single integer (batchCount) each macrotask; when N consecutive ticks see
     * no change, the queue is drained.
     *
     * A no-op on runtimes with no observer attached (returns immediately with
     * drained:true, waited:0) -- there is nothing pending on the heap or none
     * sources, and on gc source without .start(), the observer isn't listening.
     *
     * Implemented with an explicit Promise constructor and self-scheduling
     * setTimeout callback rather than async/await. This avoids the async
     * state-machine allocation the transpiler emits per await point, and
     * keeps every allocation on this path visible in one function body.
     *
     * @param {{ quietTicks?: number, maxWaitMs?: number }} [options]
     *   quietTicks: consecutive quiet ticks required to declare drained (default 2).
     *   maxWaitMs:  hard timeout, ms (default 200). On timeout, resolves with
     *               drained:false so callers can downgrade a verdict to inconclusive.
     * @returns {Promise<{drained: boolean, waited: number}>}
     */
    settle(options) {
        if (!this._obs) return Promise.resolve({ drained: true, waited: 0 });
        const opts = options || {};
        const quietTicks = opts.quietTicks > 0 ? opts.quietTicks | 0 : 2;
        const maxWaitMs = opts.maxWaitMs > 0 ? +opts.maxWaitMs : 200;
        const self = this;
        const now = (typeof performance !== 'undefined') ? performance : { now: Date.now };
        const start = now.now();
        let quiet = 0;
        let lastCount = this._batchCount;
        return new Promise((resolve) => {
            function tick() {
                const elapsed = now.now() - start;
                if (self._batchCount === lastCount) {
                    quiet++;
                    if (quiet >= quietTicks) { resolve({ drained: true, waited: elapsed }); return; }
                } else {
                    quiet = 0;
                    lastCount = self._batchCount;
                }
                if (elapsed >= maxWaitMs) { resolve({ drained: false, waited: elapsed }); return; }
                setTimeout(tick, 0);
            }
            setTimeout(tick, 0);
        });
    }

    /**
     * Sample the JS heap once. Positive deltas accrue as allocation; a decrease is
     * treated as a collection (a drop), its magnitude as bytes freed. Zero-allocation.
     *
     * In Chrome, call with no `usedBytes` and it reads performance.memory automatically.
     * Elsewhere (node, workers) pass a heap figure explicitly, e.g.
     * `gc.sampleHeap(now, process.memoryUsage().heapUsed)`. A no-op if neither is available.
     *
     * @param {number} [now]        timestamp in ms; defaults to performance.now().
     * @param {number} [usedBytes]  explicit used-heap figure; overrides performance.memory.
     */
    sampleHeap(now, usedBytes) {
        let used = usedBytes;
        if (used === undefined) {
            if (!HEAP_SUPPORTED || !this._wantHeap) return this;
            used = readHeapUsed();
        }
        const t = now === undefined ? (typeof performance !== 'undefined' ? performance.now() : 0) : now;
        this._heapActive = true;
        if (this._heapFirst < 0) {
            this._heapFirst = used; this._heapPeak = used; this._heapPrev = used;
            this._tPrev = t; this._heapSamples = 1; return this;
        }
        const dUsed = used - this._heapPrev;
        const dt = t - this._tPrev;
        if (dUsed > 0) this._allocBytes += dUsed;
        else if (dUsed < 0) { this._gcDrops++; this._freedBytes += -dUsed; }
        if (dt > 0) this._elapsedMs += dt;
        if (used > this._heapPeak) this._heapPeak = used;
        this._heapPrev = used; this._tPrev = t; this._heapSamples++;
        return this;
    }

    /**
     * Take a UASM measurement via performance.measureUserAgentSpecificMemory().
     * Returns a Promise; the measurement is async and can take tens of ms.
     *
     * On runtimes without the API (or without cross-origin isolation), no-ops
     * and returns a resolved Promise with { supported: false }. This keeps
     * callers portable -- they can await unconditionally.
     *
     * Coarse and slow: never call per-frame. Typical use is a few times per
     * measurement window (start, mid, end) to capture growth rate.
     *
     * @param {number} [now]       explicit timestamp; defaults to performance.now()
     * @returns {Promise<{supported: boolean, bytes?: number}>}
     */
    sampleUasm(now) {
        if (!UASM_SUPPORTED) return Promise.resolve({ supported: false });
        const self = this;
        const t = now === undefined ? performance.now() : now;
        return performance.measureUserAgentSpecificMemory().then(function (result) {
            const bytes = result && typeof result.bytes === 'number' ? result.bytes : 0;
            if (self._uasmFirst < 0) {
                self._uasmFirst = bytes;
                self._uasmT0 = t;
            }
            if (bytes > self._uasmPeak) self._uasmPeak = bytes;
            self._uasmBytes = bytes;
            self._uasmTPrev = t;
            self._uasmSamples++;
            return { supported: true, bytes };
        });
    }

    /**
     * Record a frame duration for the long-frame anomaly heuristic (any environment).
     * A frame past 1.5x the smoothed baseline (and above a small floor) counts as long;
     * on Chrome, a long frame coincident with a heap drop is a likely GC pause.
     */
    markFrame(frameMs) {
        this._frames++;
        const m = +frameMs || 0;
        if (this._frameEwma === 0) this._frameEwma = m;
        else this._frameEwma += (m - this._frameEwma) * 0.05;
        if (m > this._frameEwma * 1.5 && m > 4) this._longFrames++;
        return this;
    }

    summary(meta) {
        const s = {
            schema: 'lite-gc/1',
            source: this.source,
            supported: this.supported,
            gc: {
                count: this._count,
                totalMs: this._sumMs,
                maxMs: this._maxMs,
                avgMs: this._count ? this._sumMs / this._count : 0,
                p99Ms: percentile(this._dur, this._scratch, 0.99),
                minor: this._minor, major: this._major,
                incremental: this._incremental, weakcb: this._weakcb
            },
            heap: (HEAP_SUPPORTED || this._heapActive) ? {
                supported: true,
                used: this._heapPrev < 0 ? 0 : this._heapPrev,
                peak: this._heapPeak,
                firstSample: this._heapFirst < 0 ? 0 : this._heapFirst,
                samples: this._heapSamples,
                allocBytes: this._allocBytes,
                allocRateBytesPerSec: this._elapsedMs > 0 ? (this._allocBytes * 1000 / this._elapsedMs) : 0,
                gcDrops: this._gcDrops,
                freedBytes: this._freedBytes
            } : {
                supported: false, used: 0, peak: 0, firstSample: 0, samples: 0,
                allocBytes: 0, allocRateBytesPerSec: 0, gcDrops: 0, freedBytes: 0
            },
            // UASM block. Always present so callers can access uniformly.
            // supported: false + zeros when the API is unavailable OR when it
            // is available but the user never called sampleUasm().
            uasm: (UASM_SUPPORTED && this._uasmSamples > 0) ? {
                supported: true,
                bytes: this._uasmBytes,
                peak: this._uasmPeak,
                firstSample: this._uasmFirst < 0 ? 0 : this._uasmFirst,
                samples: this._uasmSamples,
                // Growth rate (bytes/sec) across the sampled window. Requires >=2 samples
                // for a meaningful delta; falls to 0 with a single sample.
                growthRate: (this._uasmSamples >= 2 && this._uasmTPrev > this._uasmT0)
                    ? ((this._uasmBytes - this._uasmFirst) * 1000 / (this._uasmTPrev - this._uasmT0))
                    : 0
            } : {
                supported: UASM_SUPPORTED,
                bytes: 0, peak: 0, firstSample: 0, samples: 0, growthRate: 0
            },
            frames: { count: this._frames, long: this._longFrames },
            // Per-phase gc stats. Empty object when no phase() calls happened.
            // avgMs is computed here from totalMs/count; p99Ms is omitted per phase
            // to avoid a duration ring per phase (would be ~64KB for 32 phases).
            phases: this._buildPhasesSnapshot(),
            // Per-region gc stats. Empty object when no enter() calls happened.
            // Includes an "unattributed" bucket only when non-zero.
            byRegion: this._buildRegionsSnapshot()
        };
        if (meta) for (const k in meta) if (!(k in s)) s[k] = meta[k];
        return s;
    }

    _buildPhasesSnapshot() {
        const out = {};
        for (let i = 0; i < this._phaseIdxCount; i++) {
            const name = this._phaseNames[i];
            const count = this._phaseCount[i];
            out[name] = {
                gc: {
                    count,
                    totalMs: this._phaseSumMs[i],
                    maxMs: this._phaseMaxMs[i],
                    avgMs: count ? this._phaseSumMs[i] / count : 0,
                    minor: this._phaseMinor[i],
                    major: this._phaseMajor[i],
                    incremental: this._phaseIncremental[i],
                    weakcb: this._phaseWeakcb[i]
                }
            };
        }
        return out;
    }

    _buildRegionsSnapshot() {
        const out = {};
        for (let i = 0; i < this._regionIdxCount; i++) {
            const name = this._regionNames[i];
            const count = this._regionCount[i];
            out[name] = {
                gc: {
                    count,
                    totalMs: this._regionSumMs[i],
                    maxMs: this._regionMaxMs[i],
                    avgMs: count ? this._regionSumMs[i] / count : 0,
                    minor: this._regionMinor[i],
                    major: this._regionMajor[i],
                    incremental: this._regionIncremental[i],
                    weakcb: this._regionWeakcb[i]
                }
            };
        }
        // Only include unattributed bucket if it saw events.
        if (this._regionUnattrCount > 0) {
            const c = this._regionUnattrCount;
            out.unattributed = {
                gc: {
                    count: c,
                    totalMs: this._regionUnattrSumMs,
                    maxMs: this._regionUnattrMaxMs,
                    avgMs: this._regionUnattrSumMs / c,
                    minor: this._regionUnattrMinor,
                    major: this._regionUnattrMajor,
                    incremental: this._regionUnattrIncremental,
                    weakcb: this._regionUnattrWeakcb
                }
            };
        }
        return out;
    }

    reset() {
        this._dur.clear();
        this._count = 0; this._sumMs = 0; this._maxMs = 0;
        this._minor = 0; this._major = 0; this._incremental = 0; this._weakcb = 0;
        this._heapActive = false;
        this._heapPrev = -1; this._heapPeak = 0; this._heapFirst = -1; this._heapSamples = 0;
        // windowed accumulators: without these, allocBytes/elapsedMs/gcDrops leak
        // across windows and allocRateBytesPerSec reports a blend of old and new
        this._allocBytes = 0; this._gcDrops = 0; this._freedBytes = 0;
        this._tPrev = -1; this._elapsedMs = 0;
        // uasm accumulators are windowed too
        this._uasmBytes = 0; this._uasmPeak = 0; this._uasmFirst = -1; this._uasmSamples = 0;
        this._uasmT0 = -1; this._uasmTPrev = -1;
        // the frame anomaly heuristic is windowed too
        this._frames = 0; this._longFrames = 0; this._frameEwma = 0;
        // phase attribution is windowed as well: intern table drops so that a
        // reused name after reset gets a fresh index, and per-phase counters clear.
        this._phaseNames.length = 0;
        this._phaseIndex.clear();
        this._phaseIdxCount = 0;
        this._currentPhaseIdx = -1;
        this._boundaryCount = 0;
        this._phaseCount.fill(0);
        this._phaseSumMs.fill(0);
        this._phaseMaxMs.fill(0);
        this._phaseMinor.fill(0);
        this._phaseMajor.fill(0);
        this._phaseIncremental.fill(0);
        this._phaseWeakcb.fill(0);
        // settle() batch counter is windowed too
        this._batchCount = 0;
        // region attribution is windowed as well
        this._regionNames.length = 0;
        this._regionIndex.clear();
        this._regionIdxCount = 0;
        this._regionStackDepth = 0;
        this._regionIntervalCount = 0;
        this._regionCount.fill(0);
        this._regionSumMs.fill(0);
        this._regionMaxMs.fill(0);
        this._regionMinor.fill(0);
        this._regionMajor.fill(0);
        this._regionIncremental.fill(0);
        this._regionWeakcb.fill(0);
        this._regionUnattrCount = 0;
        this._regionUnattrSumMs = 0;
        this._regionUnattrMaxMs = 0;
        this._regionUnattrMinor = 0;
        this._regionUnattrMajor = 0;
        this._regionUnattrIncremental = 0;
        this._regionUnattrWeakcb = 0;
    }

    destroy() { this.stop(); this._dur = null; this._scratch = null; return this; }
}

// ---- budget gate ----
const GC_DEFAULT_RULES = { maxMajor: 0 };   // any full-heap GC in the window is a failure

// Verifiability matrix: for each rule, whether the given source can answer it.
//   'yes'       -> always verifiable on this source
//   'no'        -> never verifiable on this source (verdict becomes inconclusive)
//   'needsHeap' -> verifiable iff summary.heap.samples >= 2 (a delta requires two points)
//   'needsUasm' -> verifiable iff summary.uasm.samples >= 2 (uasm-primary equivalent)
// Kept as data, not code, so future sources extend by adding a column rather
// than touching branches.
const VERDICT_MATRIX = {
    maxMajor:     { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    maxMinor:     { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    maxPauseMs:   { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    maxTotalMs:   { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    maxAllocRate: { gc: 'needsHeap', heap: 'needsHeap', uasm: 'needsUasm', none: 'no' },
    // Per-op rules added in v1.3.0 (Batch 6, G14/G15). Verifiability mirrors
    // the whole-window rules: bytes-per-op needs a memory channel, event-kind
    // rates need 'gc' source. Semantics documented in assertOps().
    maxBytesPerOp:    { gc: 'needsHeap', heap: 'needsHeap', uasm: 'needsUasm', none: 'no' },
    maxMajorsPerKOp:  { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    maxMinorsPerKOp:  { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    maxPauseMsPerOp:  { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    // Per-frame rules added in v1.4.0 (Batch 7, G17/G18). Mirror the per-op
    // rules for the memory + GC-event columns; the last row -- maxDroppedFrames
    // -- is source-agnostic because work-time is measured directly from
    // performance.now(), no channel needed. This is the first rule in the
    // matrix that gates on 'none' with 'yes', and the shape stays clean.
    maxBytesPerFrame:    { gc: 'needsHeap', heap: 'needsHeap', uasm: 'needsUasm', none: 'no' },
    maxMajorsPerKFrame:  { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    maxMinorsPerKFrame:  { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    maxPauseMsPerFrame:  { gc: 'yes',       heap: 'no',        uasm: 'no',        none: 'no' },
    maxDroppedFrames:    { gc: 'yes',       heap: 'yes',       uasm: 'yes',       none: 'yes' }
};

function isCheckable(rule, source, summary) {
    const row = VERDICT_MATRIX[rule];
    if (!row) return false;                     // unknown rule name is never checkable
    const state = row[source];
    if (state === 'yes') return true;
    if (state === 'no') return false;
    if (state === 'needsHeap') return summary.heap && summary.heap.samples >= 2;
    if (state === 'needsUasm') return summary.uasm && summary.uasm.samples >= 2;
    return false;
}

// Phase-scoped verifiability. Phases attribute GC events only in G2 -- heap and
// frame accounting stay global -- so rules that need heap deltas per phase are
// necessarily inconclusive at the phase level. `needsHeap` maps to false here
// deliberately, not to global heap samples. Third arg (summary) is unused; kept
// so isCheckable and isCheckableInPhase share the same shape at call sites.
function isCheckableInPhase(rule, source, _summary) {
    const row = VERDICT_MATRIX[rule];
    if (!row) return false;
    const state = row[source];
    if (state === 'yes') return true;
    return false;                                // 'no' and 'needsHeap' both inconclusive per-phase
}

// Internal: evaluate rules against a gc-stat block, appending to violations and
// checked. `scope` is a label used in violation metrics ('' for global, phase
// name for per-phase). Returns whether any rule went unverifiable.
function _evalRules(rules, gcStat, heapStat, summary, scope, checkFn, violations, checked) {
    let anyUnchecked = false;
    const source = summary.source;
    const prefix = scope ? 'phases.' + scope + '.gc.' : 'gc.';
    const rateMetric = scope ? 'phases.' + scope + '.heap.allocRateBytesPerSec' : 'heap.allocRateBytesPerSec';

    if (rules.maxMajor !== undefined) {
        const ok = checkFn('maxMajor', source, summary);
        checked.maxMajor = ok;
        if (!ok) anyUnchecked = true;
        else if (gcStat.major > rules.maxMajor) violations.push({ metric: prefix + 'major', limit: rules.maxMajor, actual: gcStat.major, reason: (scope ? '[' + scope + '] ' : '') + gcStat.major + ' major GC(s) > ' + rules.maxMajor });
    }
    if (rules.maxMinor !== undefined) {
        const ok = checkFn('maxMinor', source, summary);
        checked.maxMinor = ok;
        if (!ok) anyUnchecked = true;
        else if (gcStat.minor > rules.maxMinor) violations.push({ metric: prefix + 'minor', limit: rules.maxMinor, actual: gcStat.minor, reason: (scope ? '[' + scope + '] ' : '') + gcStat.minor + ' minor GC(s) > ' + rules.maxMinor });
    }
    if (rules.maxPauseMs !== undefined) {
        const ok = checkFn('maxPauseMs', source, summary);
        checked.maxPauseMs = ok;
        if (!ok) anyUnchecked = true;
        else if (gcStat.maxMs > rules.maxPauseMs) violations.push({ metric: prefix + 'maxMs', limit: rules.maxPauseMs, actual: gcStat.maxMs, reason: (scope ? '[' + scope + '] ' : '') + 'max GC pause ' + gcStat.maxMs.toFixed(3) + 'ms > ' + rules.maxPauseMs + 'ms' });
    }
    if (rules.maxTotalMs !== undefined) {
        const ok = checkFn('maxTotalMs', source, summary);
        checked.maxTotalMs = ok;
        if (!ok) anyUnchecked = true;
        else if (gcStat.totalMs > rules.maxTotalMs) violations.push({ metric: prefix + 'totalMs', limit: rules.maxTotalMs, actual: gcStat.totalMs, reason: (scope ? '[' + scope + '] ' : '') + 'total GC ' + gcStat.totalMs.toFixed(3) + 'ms > ' + rules.maxTotalMs + 'ms' });
    }
    if (rules.maxAllocRate !== undefined) {
        // Heap accounting is global-only in G2; per-phase alloc rate is unverifiable
        // regardless of source. isCheckableInPhase encodes that (returns false).
        const ok = checkFn('maxAllocRate', source, summary);
        checked.maxAllocRate = ok;
        if (!ok) anyUnchecked = true;
        else {
            // Pick the actual rate from whichever memory channel matches the source.
            // For source='uasm', use summary.uasm.growthRate; otherwise heap.
            const rate = source === 'uasm'
                ? (summary.uasm ? summary.uasm.growthRate : 0)
                : (heapStat ? heapStat.allocRateBytesPerSec : 0);
            if (rate > rules.maxAllocRate) violations.push({ metric: rateMetric, limit: rules.maxAllocRate, actual: rate, reason: (scope ? '[' + scope + '] ' : '') + 'alloc rate ' + (rate / 1048576).toFixed(2) + 'MB/s > ' + (rules.maxAllocRate / 1048576).toFixed(2) + 'MB/s' });
        }
    }
    return anyUnchecked;
}

/**
 * Evaluate a summary against a rules object. Returns a report with three-state verdict.
 *
 *   { verdict: 'pass' | 'fail' | 'inconclusive',
 *     ok: boolean,                          // computed alias for verdict === 'pass' (v1.0.0 back-compat)
 *     violations: [...],
 *     checked: { [ruleName]: boolean },     // global rules the caller set (G1 shape)
 *     checkedByPhase: { [phase]: {...} },   // per-phase rules the caller set (G2 addition)
 *     source: 'gc' | 'heap' | 'none' }
 *
 * Rules shape:
 *   { maxMajor: 0, maxPauseMs: 4,           // global rules (as in G1)
 *     phases: {                             // per-phase rules (G2)
 *       warmup: { maxMajor: 1 },
 *       steady: { maxMajor: 0, maxMinor: 0 }
 *     } }
 *
 * A phase rule referencing a phase that was never declared is inconclusive: the
 * gate cannot verify a claim about a phase that did not happen.
 */
function checkNoGc(summary, rules) {
    const r = rules === undefined ? GC_DEFAULT_RULES : rules;
    const source = summary.source;
    const violations = [];
    const checked = {};
    const checkedByPhase = {};
    const checkedByRegion = {};
    let anyUnchecked = false;

    // Global rules -- exact G1 semantics.
    anyUnchecked = _evalRules(r, summary.gc, summary.heap, summary, '', isCheckable, violations, checked) || anyUnchecked;

    // Per-phase rules.
    if (r.phases) {
        const declared = summary.phases || {};
        for (const phaseName in r.phases) {
            const phaseRules = r.phases[phaseName];
            const scoped = {};
            checkedByPhase[phaseName] = scoped;

            if (!declared[phaseName]) {
                // Phase never declared: every rule for it is inconclusive.
                // We still populate checked entries so the caller can see what
                // they asked about; each maps to false.
                for (const ruleName in phaseRules) if (VERDICT_MATRIX[ruleName]) scoped[ruleName] = false;
                if (Object.keys(scoped).length > 0) anyUnchecked = true;
                continue;
            }
            // Phase declared -- evaluate against its gc block.
            anyUnchecked = _evalRules(phaseRules, declared[phaseName].gc, null, summary, phaseName, isCheckableInPhase, violations, scoped) || anyUnchecked;
        }
    }

    // Per-region rules (G10). Same shape as per-phase.
    if (r.perRegion) {
        const declaredRegions = summary.byRegion || {};
        for (const regionName in r.perRegion) {
            const regionRules = r.perRegion[regionName];
            const scoped = {};
            checkedByRegion[regionName] = scoped;

            if (!declaredRegions[regionName]) {
                // Region never entered: rules for it are inconclusive.
                for (const ruleName in regionRules) if (VERDICT_MATRIX[ruleName]) scoped[ruleName] = false;
                if (Object.keys(scoped).length > 0) anyUnchecked = true;
                continue;
            }
            // Region entered -- evaluate against its gc block. Uses the phase-scoped
            // verifiability (heap-dependent rules unverifiable at region level in G10;
            // per-region heap accounting is not tracked).
            anyUnchecked = _evalRules(regionRules, declaredRegions[regionName].gc, null, summary, 'byRegion.' + regionName, isCheckableInPhase, violations, scoped) || anyUnchecked;
        }
    }

    // Verdict precedence: fail > inconclusive > pass.
    // A violation is a hard fail even if other rules are unverifiable -- the gate
    // has evidence of a failure and should say so.
    let verdict;
    if (violations.length > 0) verdict = 'fail';
    else if (anyUnchecked) verdict = 'inconclusive';
    else verdict = 'pass';

    return { kind: 'gc', verdict, ok: verdict === 'pass', violations, checked, checkedByPhase, checkedByRegion, source };
}

class GcBudgetError extends Error {
    constructor(report) {
        super('GC budget exceeded: ' + report.violations.map((v) => v.reason).join('; '));
        this.name = 'GcBudgetError';
        this.report = report;
    }
}

class GcInconclusiveError extends Error {
    constructor(report) {
        const un = [];
        if (report.checked) for (const k in report.checked) if (report.checked[k] === false) un.push(k);
        if (report.checkedByPhase) {
            for (const phase in report.checkedByPhase) {
                const scoped = report.checkedByPhase[phase];
                for (const k in scoped) if (scoped[k] === false) un.push(phase + '.' + k);
            }
        }
        if (report.checkedByRegion) {
            for (const region in report.checkedByRegion) {
                const scoped = report.checkedByRegion[region];
                for (const k in scoped) if (scoped[k] === false) un.push('byRegion.' + region + '.' + k);
            }
        }
        const reason = report.reason ? ' (' + report.reason + ')' : '';
        const src = report.source || 'unknown';
        super('GC gate inconclusive on source=' + src + reason
            + ': cannot verify rule(s) [' + un.join(', ') + ']. '
            + 'Pass { allowInconclusive: true } to accept, '
            + 'or gate only on rules this source can answer.');
        this.name = 'GcInconclusiveError';
        this.report = report;
    }
}

/**
 * Assert a summary passes the rules.
 *   - verdict='fail'         -> throws GcBudgetError
 *   - verdict='inconclusive' -> throws GcInconclusiveError, unless { allowInconclusive: true }
 *   - verdict='pass'         -> returns the report
 *
 * The default is strict: a gate that cannot answer must not be silently green.
 */
function assertNoGc(summary, rules, options) {
    const rep = checkNoGc(summary, rules);
    if (rep.verdict === 'fail') throw new GcBudgetError(rep);
    if (rep.verdict === 'inconclusive' && !(options && options.allowInconclusive)) {
        throw new GcInconclusiveError(rep);
    }
    return rep;
}

// ---- differential gate (G4) ----
//
// Falsifiability against harness noise: a candidate is compared to a control
// (pooled/noop) run on the same source. Rules gate on the DELTA (candidate -
// control), not absolute numbers. If the harness itself allocates or triggers
// GC, both sides suffer equally and the delta stays clean; if the candidate is
// actually dirty, the delta widens.
//
// Interleaving contract: control and candidate summaries should come from
// interleaved reps to absorb machine-mood variance. This gate does not enforce
// interleaving -- that's the caller's discipline -- but it does refuse to
// compare across sources.

// Rule -> underlying metric mapping. Same verifiability rules apply (a
// differential is only as verifiable as the metric it compares).
const DIFFERENTIAL_RULE_TO_METRIC = {
    maxExtraMajor: 'maxMajor',
    maxExtraMinor: 'maxMinor',
    maxExtraPauseMs: 'maxPauseMs',
    maxExtraTotalMs: 'maxTotalMs',
    maxExtraAllocRate: 'maxAllocRate'
};

const GC_DEFAULT_DIFFERENTIAL_RULES = { maxExtraMajor: 0 };

/**
 * Compare a candidate summary against a control (pooled/noop) baseline.
 * Rules gate on the delta (candidate - control), not absolute numbers.
 *
 * If control.source !== candidate.source, the differential is meaningless and
 * verdict is inconclusive (sources differ).
 *
 *   { verdict, ok, violations, checked, source, controlSource, candidateSource }
 */
function compareGc(control, candidate, rules) {
    const r = rules === undefined ? GC_DEFAULT_DIFFERENTIAL_RULES : rules;
    const controlSource = control.source;
    const candidateSource = candidate.source;
    const violations = [];
    const checked = {};
    let anyUnchecked = false;

    // Source mismatch invalidates the differential entirely.
    if (controlSource !== candidateSource) {
        for (const ruleName in r) if (DIFFERENTIAL_RULE_TO_METRIC[ruleName]) checked[ruleName] = false;
        return {
            kind: 'compare',
            verdict: 'inconclusive',
            ok: false,
            violations: [],
            checked,
            reason: 'source_mismatch',
            source: 'mixed',
            controlSource,
            candidateSource
        };
    }

    const source = controlSource;

    // Deltas per metric. Only compute the ones the caller asked about.
    if (r.maxExtraMajor !== undefined) {
        const ok = isCheckable('maxMajor', source, candidate);
        checked.maxExtraMajor = ok;
        if (!ok) anyUnchecked = true;
        else {
            const delta = candidate.gc.major - control.gc.major;
            if (delta > r.maxExtraMajor) violations.push({ metric: 'gc.major.delta', limit: r.maxExtraMajor, actual: delta, reason: 'extra major GC(s): ' + delta + ' > ' + r.maxExtraMajor });
        }
    }
    if (r.maxExtraMinor !== undefined) {
        const ok = isCheckable('maxMinor', source, candidate);
        checked.maxExtraMinor = ok;
        if (!ok) anyUnchecked = true;
        else {
            const delta = candidate.gc.minor - control.gc.minor;
            if (delta > r.maxExtraMinor) violations.push({ metric: 'gc.minor.delta', limit: r.maxExtraMinor, actual: delta, reason: 'extra minor GC(s): ' + delta + ' > ' + r.maxExtraMinor });
        }
    }
    if (r.maxExtraPauseMs !== undefined) {
        const ok = isCheckable('maxPauseMs', source, candidate);
        checked.maxExtraPauseMs = ok;
        if (!ok) anyUnchecked = true;
        else {
            const delta = candidate.gc.maxMs - control.gc.maxMs;
            if (delta > r.maxExtraPauseMs) violations.push({ metric: 'gc.maxMs.delta', limit: r.maxExtraPauseMs, actual: delta, reason: 'extra max pause: ' + delta.toFixed(3) + 'ms > ' + r.maxExtraPauseMs + 'ms' });
        }
    }
    if (r.maxExtraTotalMs !== undefined) {
        const ok = isCheckable('maxTotalMs', source, candidate);
        checked.maxExtraTotalMs = ok;
        if (!ok) anyUnchecked = true;
        else {
            const delta = candidate.gc.totalMs - control.gc.totalMs;
            if (delta > r.maxExtraTotalMs) violations.push({ metric: 'gc.totalMs.delta', limit: r.maxExtraTotalMs, actual: delta, reason: 'extra total pause: ' + delta.toFixed(3) + 'ms > ' + r.maxExtraTotalMs + 'ms' });
        }
    }
    if (r.maxExtraAllocRate !== undefined) {
        // Alloc rate needs samples on BOTH sides for a meaningful delta.
        const ok = isCheckable('maxAllocRate', source, candidate)
                && isCheckable('maxAllocRate', source, control);
        checked.maxExtraAllocRate = ok;
        if (!ok) anyUnchecked = true;
        else {
            // Pick the actual rate from whichever memory channel matches the source.
            const cRate = source === 'uasm'
                ? (candidate.uasm ? candidate.uasm.growthRate : 0)
                : candidate.heap.allocRateBytesPerSec;
            const ctlRate = source === 'uasm'
                ? (control.uasm ? control.uasm.growthRate : 0)
                : control.heap.allocRateBytesPerSec;
            const delta = cRate - ctlRate;
            if (delta > r.maxExtraAllocRate) violations.push({ metric: (source === 'uasm' ? 'uasm.growthRate.delta' : 'heap.allocRateBytesPerSec.delta'), limit: r.maxExtraAllocRate, actual: delta, reason: 'extra alloc rate: ' + (delta / 1048576).toFixed(2) + 'MB/s > ' + (r.maxExtraAllocRate / 1048576).toFixed(2) + 'MB/s' });
        }
    }

    let verdict;
    if (violations.length > 0) verdict = 'fail';
    else if (anyUnchecked) verdict = 'inconclusive';
    else verdict = 'pass';

    return { kind: 'compare', verdict, ok: verdict === 'pass', violations, checked, source, controlSource, candidateSource };
}

/**
 * Assert form of compareGc. Same semantics as assertNoGc:
 *   verdict='fail'         -> throws GcBudgetError
 *   verdict='inconclusive' -> throws GcInconclusiveError, unless { allowInconclusive: true }
 *   verdict='pass'         -> returns the report
 */
function assertCompare(control, candidate, rules, options) {
    const rep = compareGc(control, candidate, rules);
    if (rep.verdict === 'fail') throw new GcBudgetError(rep);
    if (rep.verdict === 'inconclusive' && !(options && options.allowInconclusive)) {
        throw new GcInconclusiveError(rep);
    }
    return rep;
}

// ---- rep-aware gating (G5) ----
//
// Rep aggregation and policy-based gating. Matches the ecosystem's benchmark
// discipline: interleaved reps, minimums-as-headline for pauses, all-clean
// for kind-strict claims. D4-approved defaults:
//   majors, minors -> 'all-clean'   (any offending rep falsifies the claim)
//   pauses, rates  -> 'best-clean'  (the best rep proves the state is achievable)

const REP_POLICY_DEFAULTS = {
    maxMajor: 'all-clean',
    maxMinor: 'all-clean',
    maxPauseMs: 'best-clean',
    maxTotalMs: 'best-clean',
    maxAllocRate: 'best-clean'
};

function _extract(summaries, path) {
    // path is 'gc.major' or 'heap.allocRateBytesPerSec'. Returns 0 for any
    // summary that lacks the sub-path so aggregation stays tolerant of
    // hand-built summaries missing newer blocks (uasm was added in v1.2.0).
    const parts = path.split('.');
    const out = new Array(summaries.length);
    for (let i = 0; i < summaries.length; i++) {
        let v = summaries[i];
        for (let j = 0; j < parts.length; j++) {
            if (v === undefined || v === null) { v = 0; break; }
            v = v[parts[j]];
        }
        out[i] = typeof v === 'number' ? v : 0;
    }
    return out;
}

function _stats(values) {
    if (values.length === 0) return { min: 0, median: 0, max: 0, all: values };
    // Copy and sort ascending to compute min/median/max; do not mutate caller's array.
    const sorted = values.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const min = sorted[0];
    const max = sorted[n - 1];
    const median = (n & 1) ? sorted[(n - 1) >> 1] : (sorted[(n >> 1) - 1] + sorted[n >> 1]) / 2;
    return { min, median, max, all: values };
}

/**
 * Aggregate an array of summaries across reps.
 *
 *   { reps, sources: string[], gc: { major:{min,median,max,all}, ... },
 *     heap: { allocRateBytesPerSec:{...}, ... }, perRep: summaries }
 *
 * `sources` is the unique source strings seen across reps. If more than one,
 * downstream gating should treat mixed sources as inconclusive.
 */
function aggregateGc(summaries) {
    if (!Array.isArray(summaries)) {
        throw new TypeError('aggregateGc: summaries must be an array');
    }
    const reps = summaries.length;
    const sourceSet = {};
    for (let i = 0; i < reps; i++) sourceSet[summaries[i].source] = true;
    const sources = Object.keys(sourceSet);

    const gcMetrics = ['major', 'minor', 'incremental', 'weakcb', 'maxMs', 'totalMs', 'p99Ms', 'count'];
    const heapMetrics = ['allocRateBytesPerSec', 'allocBytes', 'gcDrops', 'samples'];
    const uasmMetrics = ['growthRate', 'bytes', 'peak', 'samples'];

    const gc = {};
    for (const m of gcMetrics) gc[m] = _stats(_extract(summaries, 'gc.' + m));
    const heap = {};
    for (const m of heapMetrics) heap[m] = _stats(_extract(summaries, 'heap.' + m));
    const uasm = {};
    for (const m of uasmMetrics) uasm[m] = _stats(_extract(summaries, 'uasm.' + m));

    return { reps, sources, gc, heap, uasm, perRep: summaries };
}

// Given a rule (e.g. maxMajor), an aggregate, a policy, and the underlying
// metric name (e.g. 'gc.major'), decide the verdict for that rule alone.
//
// Returns { verdict: 'pass' | 'fail', actual } for the policy's chosen sample
// (min for 'best-clean', max for 'all-clean', median for 'median', etc).
function _applyPolicy(policy, statsBlock, ruleName, limit) {
    // 'best-clean' -> the min value across reps must satisfy the rule.
    //   Rationale: a single clean rep proves the clean state is achievable.
    // 'all-clean'  -> the max value across reps must satisfy the rule.
    //   Rationale: any rep exceeding limit falsifies "all reps clean".
    // 'median'     -> the median across reps must satisfy the rule.
    //   Rationale: the middle rep represents typical behavior.
    // 'quorum-N'   -> at least N reps must individually satisfy the rule.
    if (policy === 'best-clean') return { actual: statsBlock.min, ok: statsBlock.min <= limit };
    if (policy === 'all-clean')  return { actual: statsBlock.max, ok: statsBlock.max <= limit };
    if (policy === 'median')     return { actual: statsBlock.median, ok: statsBlock.median <= limit };
    if (typeof policy === 'string' && policy.indexOf('quorum-') === 0) {
        const need = parseInt(policy.slice(7), 10);
        if (!(need > 0)) return { actual: 0, ok: false, error: 'invalid quorum policy: ' + policy };
        let passing = 0;
        for (let i = 0; i < statsBlock.all.length; i++) if (statsBlock.all[i] <= limit) passing++;
        return { actual: passing, ok: passing >= need };
    }
    return { actual: 0, ok: false, error: 'unknown policy: ' + policy };
}

const RULE_TO_STATS_PATH = {
    maxMajor: ['gc', 'major'],
    maxMinor: ['gc', 'minor'],
    maxPauseMs: ['gc', 'maxMs'],
    maxTotalMs: ['gc', 'totalMs'],
    maxAllocRate: ['heap', 'allocRateBytesPerSec']
};

/**
 * Gate an array of summaries against rules using per-rule policies.
 *
 *   gateReps(summaries, { maxMajor: 0, maxPauseMs: 4 }, { policy: { maxPauseMs: 'median' } })
 *
 * Default policy per rule (D4-approved):
 *   maxMajor, maxMinor       -> 'all-clean'
 *   maxPauseMs, maxTotalMs   -> 'best-clean'
 *   maxAllocRate             -> 'best-clean'
 *
 * Policy overrides via options.policy: { maxMajor: 'quorum-8', ... }.
 *
 * Verdict semantics identical to checkNoGc: fail > inconclusive > pass.
 * Mixed sources across reps -> inconclusive.
 */
function gateReps(summaries, rules, options) {
    if (!Array.isArray(summaries) || summaries.length === 0) {
        throw new TypeError('gateReps: summaries must be a non-empty array');
    }
    const r = rules === undefined ? GC_DEFAULT_RULES : rules;
    const opts = options || {};
    const userPolicy = opts.policy || {};
    const agg = aggregateGc(summaries);
    const violations = [];
    const checked = {};
    const appliedPolicy = {};
    let anyUnchecked = false;

    // Mixed sources invalidate the whole gate; downgrade to inconclusive.
    if (agg.sources.length !== 1) {
        for (const ruleName in r) if (RULE_TO_STATS_PATH[ruleName]) checked[ruleName] = false;
        return {
            kind: 'reps',
            verdict: 'inconclusive',
            ok: false,
            violations: [],
            checked,
            reason: 'mixed_sources',
            source: 'mixed',
            reps: agg.reps,
            sources: agg.sources,
            aggregate: agg,
            policy: appliedPolicy
        };
    }
    const source = agg.sources[0];
    // Use the first summary as the checkability probe (all share source; heap
    // sample counts may vary, so use the max samples across reps).
    const heapProbe = {
        source,
        heap: { samples: agg.heap.samples.max },
        // uasm samples also needed for source='uasm' verifiability check
        uasm: { samples: agg.uasm ? agg.uasm.samples.max : 0 }
    };

    // Source-parameterized rule paths: maxAllocRate reads uasm.growthRate on
    // source=uasm, heap.allocRateBytesPerSec elsewhere. All other rules stay
    // fixed (they're kind/pause rules which only make sense on source=gc).
    function pathForRule(ruleName) {
        if (ruleName === 'maxAllocRate') {
            return source === 'uasm' ? ['uasm', 'growthRate'] : ['heap', 'allocRateBytesPerSec'];
        }
        return RULE_TO_STATS_PATH[ruleName];
    }

    for (const ruleName in r) {
        const path = pathForRule(ruleName);
        if (!path) continue;                                     // unknown rule -> ignore
        const limit = r[ruleName];
        const policy = userPolicy[ruleName] || REP_POLICY_DEFAULTS[ruleName] || 'all-clean';
        appliedPolicy[ruleName] = policy;

        // Verifiability: same matrix as single-summary gating.
        const canCheck = isCheckable(ruleName, source, heapProbe);
        checked[ruleName] = canCheck;
        if (!canCheck) { anyUnchecked = true; continue; }

        const statsBlock = agg[path[0]][path[1]];
        const outcome = _applyPolicy(policy, statsBlock, ruleName, limit);
        if (!outcome.ok) {
            violations.push({
                metric: path[0] + '.' + path[1],
                limit,
                actual: outcome.actual,
                policy,
                reason: 'rep gate failed [' + policy + ']: ' + path[0] + '.' + path[1]
                    + ' actual=' + (typeof outcome.actual === 'number' ? outcome.actual.toFixed(3) : outcome.actual)
                    + ' > limit=' + limit
                    + ' across ' + agg.reps + ' reps'
            });
        }
    }

    let verdict;
    if (violations.length > 0) verdict = 'fail';
    else if (anyUnchecked) verdict = 'inconclusive';
    else verdict = 'pass';

    return {
        kind: 'reps',
        verdict,
        ok: verdict === 'pass',
        violations,
        checked,
        source,
        reps: agg.reps,
        sources: agg.sources,
        aggregate: agg,
        policy: appliedPolicy
    };
}

/**
 * Assert form of gateReps. Same throw semantics as assertNoGc.
 */
function assertReps(summaries, rules, options) {
    const rep = gateReps(summaries, rules, options);
    if (rep.verdict === 'fail') throw new GcBudgetError(rep);
    if (rep.verdict === 'inconclusive' && !(options && options.allowInconclusive)) {
        throw new GcInconclusiveError(rep);
    }
    return rep;
}

// ---- baseline lock (G6) ----
//
// Publish-gate ergonomics: capture a known-good aggregate, commit it as JSON,
// and gate future runs against it. Fingerprint drift (node/V8/platform/CPU)
// downgrades the verdict to inconclusive rather than fail -- a baseline from
// another machine cannot answer whether performance regressed on this one.
//
// No file I/O in core. captureFingerprint and checkAgainstBaseline are pure;
// createBaseline returns a JSON-able object; users serialize with fs themselves.

const BASELINE_SCHEMA = 'lite-gc-baseline/1';
const FINGERPRINT_FIELDS = ['node', 'v8', 'platform', 'arch', 'cpu'];

/**
 * Capture the environment fingerprint. Node returns full details; browsers
 * return a minimal marker. Users can extend the result with their own fields
 * before committing to a baseline (e.g. CI runner ID).
 */
function captureFingerprint() {
    if (typeof process !== 'undefined' && process.versions) {
        // Node path. os.cpus() may fail on some runtimes; guard.
        let cpu = 'unknown';
        try {
            const os = process.getBuiltinModule ? process.getBuiltinModule('os') : null;
            if (os && typeof os.cpus === 'function') {
                const cpus = os.cpus();
                if (cpus && cpus[0] && cpus[0].model) cpu = cpus[0].model;
            }
        } catch (_e) { /* leave cpu as unknown */ }
        return {
            node: process.version || 'unknown',
            v8: process.versions.v8 || 'unknown',
            platform: process.platform || 'unknown',
            arch: process.arch || 'unknown',
            cpu
        };
    }
    // Browser or other environment: minimal marker. Users override as needed.
    return { node: 'browser', v8: 'unknown', platform: 'browser', arch: 'unknown', cpu: 'unknown' };
}

function _fingerprintMatches(a, b) {
    if (!a || !b) return false;
    for (let i = 0; i < FINGERPRINT_FIELDS.length; i++) {
        const k = FINGERPRINT_FIELDS[i];
        if (a[k] !== b[k]) return false;
    }
    return true;
}

/**
 * Create a JSON-able baseline object from an aggregate. Does NOT write to disk.
 * The returned object contains the aggregate stats, the fingerprint at capture
 * time, and a schema tag. Users serialize with JSON.stringify and commit.
 *
 *   const baseline = createBaseline(aggregateGc(reps));
 *   fs.writeFileSync('gc-baseline.json', JSON.stringify(baseline, null, 2));
 */
function createBaseline(aggregate) {
    if (!aggregate || typeof aggregate !== 'object' || typeof aggregate.reps !== 'number') {
        throw new TypeError('createBaseline: aggregate must be a result from aggregateGc');
    }
    return {
        schema: BASELINE_SCHEMA,
        fingerprint: captureFingerprint(),
        capturedAt: new Date().toISOString(),
        reps: aggregate.reps,
        sources: aggregate.sources.slice(),
        // Serialize stats blocks but drop the `all` arrays; a baseline is a
        // published summary, not a raw log. If you need the log, keep it
        // yourself alongside the baseline file.
        gc: _copyStatsMap(aggregate.gc),
        heap: _copyStatsMap(aggregate.heap),
        uasm: aggregate.uasm ? _copyStatsMap(aggregate.uasm) : {}
    };
}

function _copyStatsMap(m) {
    const out = {};
    for (const k in m) {
        const s = m[k];
        out[k] = { min: s.min, median: s.median, max: s.max };
    }
    return out;
}

/**
 * Compare a current aggregate against a baseline. Verdict semantics:
 *   fingerprint mismatch (default)   -> inconclusive, reason='fingerprint_mismatch'
 *   any metric regressed             -> fail
 *   otherwise                        -> pass
 *
 * Regression semantics: current.median > baseline.max on the metric.
 *   Rationale: allowing current to be as bad as the baseline's worst absorbs
 *   run-to-run noise on the baseline capture side; a current whose typical
 *   value exceeds even the worst observed baseline is a real regression.
 *
 * Fingerprint mismatch can be overridden with { acceptFingerprintMismatch: true },
 * but the report body carries fingerprintMismatchAccepted:true as an audit trail.
 */
function checkAgainstBaseline(currentAggregate, baseline, options) {
    const opts = options || {};
    if (!baseline || baseline.schema !== BASELINE_SCHEMA) {
        return {
            kind: 'baseline',
            verdict: 'inconclusive',
            ok: false,
            violations: [],
            checked: {},
            reason: 'invalid_baseline',
            source: 'unknown'
        };
    }
    const currentFp = captureFingerprint();
    const fpMatch = _fingerprintMatches(currentFp, baseline.fingerprint);
    if (!fpMatch && !opts.acceptFingerprintMismatch) {
        return {
            kind: 'baseline',
            verdict: 'inconclusive',
            ok: false,
            violations: [],
            checked: {},
            reason: 'fingerprint_mismatch',
            baselineFingerprint: baseline.fingerprint,
            currentFingerprint: currentFp,
            source: currentAggregate.sources[0] || 'unknown'
        };
    }

    // Which metrics to compare: everything present in both aggregate and baseline.
    const violations = [];
    const checked = {};
    const metrics = [
        ['gc', 'major'], ['gc', 'minor'], ['gc', 'incremental'], ['gc', 'weakcb'],
        ['gc', 'maxMs'], ['gc', 'totalMs'], ['gc', 'p99Ms'], ['gc', 'count'],
        ['heap', 'allocRateBytesPerSec'], ['heap', 'allocBytes'], ['heap', 'gcDrops']
    ];
    for (const [group, name] of metrics) {
        const cs = currentAggregate[group] && currentAggregate[group][name];
        const bs = baseline[group] && baseline[group][name];
        if (!cs || !bs) continue;
        const key = group + '.' + name;
        checked[key] = true;
        // Regression: current.median > baseline.max
        if (cs.median > bs.max) {
            violations.push({
                metric: key,
                baselineMax: bs.max,
                currentMedian: cs.median,
                reason: 'regression: ' + key + ' current.median=' + cs.median.toFixed(3)
                    + ' > baseline.max=' + bs.max.toFixed(3)
            });
        }
    }

    let verdict;
    if (violations.length > 0) verdict = 'fail';
    else verdict = 'pass';

    const report = {
        kind: 'baseline',
        verdict,
        ok: verdict === 'pass',
        violations,
        checked,
        source: currentAggregate.sources[0] || 'unknown',
        baselineFingerprint: baseline.fingerprint,
        currentFingerprint: currentFp
    };
    if (!fpMatch) report.fingerprintMismatchAccepted = true;
    return report;
}

/**
 * Assert form of checkAgainstBaseline. Same throw semantics as assertNoGc.
 */
function assertAgainstBaseline(currentAggregate, baseline, options) {
    const rep = checkAgainstBaseline(currentAggregate, baseline, options);
    if (rep.verdict === 'fail') throw new GcBudgetError(rep);
    if (rep.verdict === 'inconclusive' && !(options && options.allowInconclusive)) {
        throw new GcInconclusiveError(rep);
    }
    return rep;
}

// ---- formatters (G7) ----
//
// Pure functions taking any report shape (checkNoGc, compareGc, gateReps,
// checkAgainstBaseline) and rendering into a target format. Dispatch on the
// `kind` field the report constructors set.
//
// ASCII-only output. Terminal color is left to callers (pipe through a
// colorizer if you want it); the ecosystem convention is unopinionated,
// portable text.

const REPORT_SCHEMA = 'lite-gc-report/1';

function _pad(str, width) {
    str = String(str);
    if (str.length >= width) return str;
    let out = str;
    for (let i = str.length; i < width; i++) out += ' ';
    return out;
}

function _title(report) {
    if (report.kind === 'compare') return 'GC gate (differential)';
    if (report.kind === 'reps') return 'GC gate (reps=' + report.reps + ')';
    if (report.kind === 'baseline') return 'GC gate vs baseline';
    return 'GC gate';
}

function _verdictBanner(report) {
    // Uppercase verdict; reason (if any) in brackets.
    const v = report.verdict.toUpperCase();
    if (report.reason) return v + ' [' + report.reason + ']';
    return v;
}

/**
 * Human-readable, monospace-aligned console output. Suitable for stderr or
 * CI job logs. Multi-line, no color codes.
 */
function formatConsole(report) {
    const lines = [];
    const src = report.kind === 'compare'
        ? 'control=' + report.controlSource + ', candidate=' + report.candidateSource
        : 'source=' + report.source;
    lines.push(_title(report) + ': ' + _verdictBanner(report) + ' (' + src + ')');

    if (report.kind === 'reps' && report.policy) {
        // Show applied policy per rule
        const ruleNames = Object.keys(report.checked);
        if (ruleNames.length > 0) {
            const w = Math.max.apply(Math, ruleNames.map((n) => n.length));
            for (const name of ruleNames) {
                const policy = report.policy[name] || '(no policy)';
                const status = report.checked[name] === false ? 'unverifiable' : 'checked';
                lines.push('  ' + _pad(name, w) + '  ' + _pad(policy, 12) + '  ' + status);
            }
        }
    }

    if (report.violations.length > 0) {
        lines.push('  Violations:');
        for (const v of report.violations) {
            lines.push('    ' + v.metric + ': ' + v.reason);
        }
    }

    // Unverifiable rules
    const unverif = [];
    if (report.checked) for (const k in report.checked) if (report.checked[k] === false) unverif.push(k);
    if (report.checkedByPhase) {
        for (const phase in report.checkedByPhase) {
            const scoped = report.checkedByPhase[phase];
            for (const k in scoped) if (scoped[k] === false) unverif.push(phase + '.' + k);
        }
    }
    if (report.checkedByRegion) {
        for (const region in report.checkedByRegion) {
            const scoped = report.checkedByRegion[region];
            for (const k in scoped) if (scoped[k] === false) unverif.push('byRegion.' + region + '.' + k);
        }
    }
    if (unverif.length > 0 && report.verdict === 'inconclusive') {
        lines.push('  Unverifiable rules:');
        for (const rule of unverif) lines.push('    ' + rule);
    }

    // Baseline-specific: fingerprint info
    if (report.kind === 'baseline' && report.baselineFingerprint) {
        if (report.reason === 'fingerprint_mismatch') {
            lines.push('  Baseline: ' + report.baselineFingerprint.node + ' / ' + report.baselineFingerprint.platform + '/' + report.baselineFingerprint.arch);
            lines.push('  Current:  ' + report.currentFingerprint.node + ' / ' + report.currentFingerprint.platform + '/' + report.currentFingerprint.arch);
        } else if (report.fingerprintMismatchAccepted) {
            lines.push('  (fingerprint mismatch was accepted via --accept-fingerprint-mismatch)');
        }
    }

    return lines.join('\n');
}

/**
 * Stable versioned JSON. Machine-readable; safe to persist across releases.
 * Wraps the report in an envelope with schema tag and capture timestamp.
 */
function formatJson(report) {
    return JSON.stringify({
        schema: REPORT_SCHEMA,
        version: VERSION,
        generatedAt: new Date().toISOString(),
        report
    }, null, 2);
}

/**
 * GitHub-flavored markdown, PR-comment ready. Uses text tags (PASS/FAIL/
 * INCONCLUSIVE) rather than emoji to stay ASCII-only per the convention.
 */
function formatMarkdown(report) {
    const lines = [];
    lines.push('### ' + _title(report) + ': `' + report.verdict.toUpperCase() + '`');
    lines.push('');

    if (report.kind === 'compare') {
        lines.push('- Control source: `' + report.controlSource + '`');
        lines.push('- Candidate source: `' + report.candidateSource + '`');
    } else {
        lines.push('- Source: `' + report.source + '`');
    }
    if (report.kind === 'reps') lines.push('- Reps: ' + report.reps);
    if (report.reason) lines.push('- Reason: `' + report.reason + '`');
    if (report.fingerprintMismatchAccepted) lines.push('- Fingerprint mismatch accepted');
    lines.push('');

    if (report.violations.length > 0) {
        lines.push('**Violations**');
        lines.push('');
        lines.push('| metric | reason |');
        lines.push('| --- | --- |');
        for (const v of report.violations) {
            lines.push('| `' + v.metric + '` | ' + v.reason + ' |');
        }
        lines.push('');
    }

    const unverif = [];
    if (report.checked) for (const k in report.checked) if (report.checked[k] === false) unverif.push(k);
    if (report.checkedByPhase) {
        for (const phase in report.checkedByPhase) {
            const scoped = report.checkedByPhase[phase];
            for (const k in scoped) if (scoped[k] === false) unverif.push(phase + '.' + k);
        }
    }
    if (report.checkedByRegion) {
        for (const region in report.checkedByRegion) {
            const scoped = report.checkedByRegion[region];
            for (const k in scoped) if (scoped[k] === false) unverif.push('byRegion.' + region + '.' + k);
        }
    }
    if (unverif.length > 0 && report.verdict === 'inconclusive') {
        lines.push('**Unverifiable rules**');
        lines.push('');
        for (const rule of unverif) lines.push('- `' + rule + '`');
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * GitHub Actions workflow-annotation lines. One line per violation or
 * unverifiable rule. Passing reports emit a single ::notice::.
 *
 * See: https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
 */
function formatGithubAnnotations(report) {
    const lines = [];
    const title = 'lite-gc-profiler';
    if (report.verdict === 'fail') {
        for (const v of report.violations) {
            lines.push('::error title=' + title + '::' + v.metric + ': ' + v.reason);
        }
    } else if (report.verdict === 'inconclusive') {
        const unverif = [];
        if (report.checked) for (const k in report.checked) if (report.checked[k] === false) unverif.push(k);
        if (report.checkedByPhase) {
            for (const phase in report.checkedByPhase) {
                const scoped = report.checkedByPhase[phase];
                for (const k in scoped) if (scoped[k] === false) unverif.push(phase + '.' + k);
            }
        }
        if (report.checkedByRegion) {
            for (const region in report.checkedByRegion) {
                const scoped = report.checkedByRegion[region];
                for (const k in scoped) if (scoped[k] === false) unverif.push('byRegion.' + region + '.' + k);
            }
        }
        const reason = report.reason ? ' (' + report.reason + ')' : '';
        lines.push('::warning title=' + title + '::gate inconclusive' + reason + ': ' + unverif.join(', '));
    } else {
        lines.push('::notice title=' + title + '::gate passed on source=' + report.source);
    }
    return lines.join('\n');
}

// =============================================================================
// PER-OP PRIMITIVES (Batch 6, G14/G15/G16)
// =============================================================================
// measureOps: run a sync function N times with an optional warmup phase, then
// return a normalized result carrying opsPerSec, bytesPerOp, and the internal
// profiler's steady-phase gc/heap/uasm stats.
//
// Design notes (D7-D10):
// - Sync-only. Async functions have ambiguous per-op accounting because
//   microtasks interleave allocations across iterations; a queued job may
//   allocate against iteration N while iteration N+1 has already started.
//   If real async demand appears, that's a separate design in v1.4+.
// - fn(i) signature. Matches alien-signals, js-reactivity-benchmark, and the
//   internal @zakkster/lite-* bench harnesses. No context object, no options
//   bag -- callers close over what they need.
// - Uses existing phase() machinery (G2) with two named phases: 'warmup' and
//   'steady'. Warmup allocations are visible in the summary but explicitly
//   quarantined from steady-phase gating. Bytes-per-op is derived from the
//   steady phase alone.
// - bytesPerOp comes from HEAP growth in the steady phase. Heap is always
//   available in Chrome (source='heap' or 'uasm' opt-in) and available in
//   node via explicit sampleHeap(now, process.memoryUsage().heapUsed) --
//   which measureOps performs at phase boundaries. On source='none'
//   (Firefox/Safari without perf.memory) bytesPerOp is null.
// - On source='uasm', the sync-only constraint means we cannot await
//   sampleUasm() at phase boundaries; heap sampling is used for bytesPerOp
//   regardless of primary source. The uasm channel is still reflected in
//   the summary if the user pre-sampled outside; measureOps itself does not
//   sample it.

const OPS_SCHEMA = 'lite-gc-ops/1';

/**
 * Run `fn(i)` `opts.ops` times (preceded by `opts.warmup` iterations) and
 * return per-op measurements plus the underlying summary. Sync-only in
 * v1.3.0; async functions have ambiguous per-op accounting.
 *
 * @param {(i: number) => any} fn        Sync function to measure. Return value ignored.
 * @param {object} opts
 * @param {number} opts.ops              Steady-phase iteration count. Required, must be > 0.
 * @param {number} [opts.warmup=0]       Warmup iteration count. Runs before steady; excluded from bytesPerOp/opsPerSec.
 * @param {'auto'|'gc'|'heap'|'uasm'|'none'} [opts.source='auto']
 *                                       Passed to the internal GcProfiler.
 * @param {number} [opts.capacity=256]   GcProfiler pause-ring capacity.
 * @param {boolean} [opts.stabilize=false]
 *                                       Force a full GC at each steady-phase boundary so
 *                                       `bytesPerOp` reflects the surviving-allocation
 *                                       delta rather than transient allocation. Requires
 *                                       node --expose-gc; throws RangeError otherwise.
 *                                       The forced-GC events are attributed to a
 *                                       separate `stabilize` phase in the summary so
 *                                       they don't inflate steady-phase gate rules.
 *                                       See README for cold-CI use case.
 * @returns {{
 *   schema: 'lite-gc-ops/1',
 *   ops: number, warmupOps: number,
 *   elapsedMs: number, opsPerSec: number,
 *   bytesPerOp: number | null,
 *   source: GcSource,
 *   summary: GcSummary
 * }}
 */
function measureOps(fn, opts) {
    if (typeof fn !== 'function') throw new TypeError('measureOps: fn must be a function');
    if (!opts || typeof opts !== 'object') throw new TypeError('measureOps: opts is required');
    const ops = opts.ops;
    const warmup = opts.warmup === undefined ? 0 : opts.warmup;
    if (!Number.isFinite(ops) || ops <= 0 || (ops | 0) !== ops) {
        throw new RangeError('measureOps: opts.ops must be a positive integer');
    }
    if (!Number.isFinite(warmup) || warmup < 0 || (warmup | 0) !== warmup) {
        throw new RangeError('measureOps: opts.warmup must be a non-negative integer');
    }
    // Stabilize mode: force full GC at each steady-phase boundary so
    // bytesPerOp reflects surviving-allocation delta (retention) rather than
    // transient allocation. Requires globalThis.gc, which node exposes only
    // under --expose-gc. Throwing at measurement time (not construction)
    // keeps the guard on the CI path where it matters, and lets code that
    // never opts in stay portable to runtimes without --expose-gc.
    const stabilize = opts.stabilize === true;
    if (stabilize && typeof globalThis.gc !== 'function') {
        throw new RangeError(
            'measureOps: opts.stabilize:true requires node --expose-gc ' +
            '(globalThis.gc must be a function). Run: node --expose-gc ... ' +
            'or drop stabilize for warmed-workload measurement.'
        );
    }

    const gc = new GcProfiler(opts.capacity || 256, { source: opts.source || 'auto' });
    gc.start();

    // Read node's process.memoryUsage() when we're on the gc source (node),
    // since perf.memory doesn't exist there. In Chrome (heap/uasm/none) the
    // sampleHeap() call reads perf.memory directly if we don't pass a bytes
    // arg. This closure isolates the difference so the phase loop stays clean.
    // When the profiler's source is 'none' we explicitly skip sampling so
    // bytesPerOp ends up null -- respecting the caller's intent to simulate
    // a memory-unaware environment even when a memory API is technically
    // available on this runtime.
    const source = gc.source;
    const isNode = typeof process !== 'undefined' && process.memoryUsage;
    const canSampleMemory = source !== 'none';
    function sampleBoundary() {
        const t = typeof performance !== 'undefined' ? performance.now() : 0;
        if (!canSampleMemory) return { t, used: -1 };
        if (isNode) {
            const used = process.memoryUsage().heapUsed;
            gc.sampleHeap(t, used);
            return { t, used };
        }
        gc.sampleHeap(t);
        return { t, used: _readHeapUsedFor(gc) };
    }

    // WARMUP phase. Always mark the phase boundary (even when warmup=0) so
    // the summary.phases shape is stable and downstream consumers can rely on
    // both keys being present.
    gc.phase('warmup');
    sampleBoundary();                                    // warmup boundary; used value not needed
    for (let i = 0; i < warmup; i++) fn(i);

    // STABILIZE (pre-steady): if opted in, force a full GC before the
    // steady-start sample so retention analysis starts from a compacted
    // heap. Attributes the forced-GC event to the 'stabilize' phase, keeping
    // 'steady' clean for gate rules.
    if (stabilize) {
        gc.phase('stabilize');
        globalThis.gc();
    }

    // STEADY phase -- what gets gated.
    gc.phase('steady');
    const startBoundary = sampleBoundary();
    const steadyStartT = startBoundary.t;
    const steadyStartUsed = startBoundary.used;
    for (let i = 0; i < ops; i++) fn(i);

    // STABILIZE (post-steady): force GC before the end-sample so the delta
    // reflects surviving retention, not transient allocation. Re-enters the
    // stabilize phase; events accumulate under it. Then re-enter steady so
    // the end-boundary sample's own accounting stays in steady (it doesn't
    // emit GC events but the phase boundary keeps the shape consistent).
    if (stabilize) {
        gc.phase('stabilize');
        globalThis.gc();
        gc.phase('steady');
    }

    const endBoundary = sampleBoundary();
    const steadyEndT = endBoundary.t;
    const steadyEndUsed = endBoundary.used;

    gc.stop();
    const summary = gc.summary();

    const elapsedMs = steadyEndT - steadyStartT;
    const opsPerSec = elapsedMs > 0 ? (ops * 1000) / elapsedMs : 0;

    // bytesPerOp: derive from raw heap deltas across the steady phase. Using
    // the delta (not summary.heap.allocBytes which is cumulative across the
    // whole window) keeps warmup allocation out of the per-op number even
    // when the profiler's window-wide accumulators reflect both phases.
    let bytesPerOp = null;
    if (steadyStartUsed >= 0 && steadyEndUsed >= 0 && ops > 0) {
        const delta = steadyEndUsed - steadyStartUsed;
        // Negative deltas mean GC ran during steady and freed more than we
        // allocated on this window. That's honest for bytesPerOp -- report 0
        // rather than a negative number that would break threshold math.
        bytesPerOp = delta > 0 ? delta / ops : 0;
    }

    return {
        schema: OPS_SCHEMA,
        ops, warmupOps: warmup,
        elapsedMs,
        opsPerSec,
        bytesPerOp,
        source: summary.source,
        summary
    };
}

// Read the profiler's most recent heap sample. Returns -1 when no channel
// exposes it (source='none'). Used to bracket the steady phase for the
// bytes-per-op delta.
function _readHeapUsedFor(gc) {
    // The profiler stores the latest sample in _heapPrev; a private read is
    // fine here since both this helper and the profiler live in the same file.
    return gc._heapPrev >= 0 ? gc._heapPrev : -1;
}

// Per-op verifiability probe. Mirrors isCheckable but reads from a measureOps
// result -- which has its own shape (has a `summary` field, no top-level heap
// or uasm blocks).
function _isCheckableOps(rule, result) {
    const source = result.source;
    const row = VERDICT_MATRIX[rule];
    if (!row) return false;
    const state = row[source];
    if (state === 'yes') return true;
    if (state === 'no') return false;
    if (state === 'needsHeap') {
        // Per-op verifiability requires bytesPerOp be derivable, which means
        // at least a start+end heap sample was captured. bytesPerOp !== null
        // is the signal we need; a zero value is still verifiable.
        return result.bytesPerOp !== null;
    }
    if (state === 'needsUasm') {
        return result.summary && result.summary.uasm && result.summary.uasm.samples >= 2;
    }
    return false;
}

// Extract the actual per-op number for a rule from a measureOps result.
function _actualPerOp(rule, result) {
    if (rule === 'maxBytesPerOp')   return result.bytesPerOp;
    // Steady phase counters live under summary.phases.steady.gc when phase()
    // was used (which measureOps always does). Fall back to window-wide gc
    // if for any reason the steady phase snapshot is missing.
    const steady = result.summary && result.summary.phases && result.summary.phases.steady;
    const g = steady ? steady.gc : result.summary.gc;
    if (rule === 'maxMajorsPerKOp')  return result.ops > 0 ? (g.major * 1000) / result.ops : 0;
    if (rule === 'maxMinorsPerKOp')  return result.ops > 0 ? (g.minor * 1000) / result.ops : 0;
    if (rule === 'maxPauseMsPerOp')  return result.ops > 0 ? g.totalMs / result.ops : 0;
    return 0;
}

// Human-readable metric name for a per-op rule (used in violation reasons).
function _perOpMetricName(rule) {
    if (rule === 'maxBytesPerOp')   return 'bytesPerOp';
    if (rule === 'maxMajorsPerKOp') return 'majorsPerKOp';
    if (rule === 'maxMinorsPerKOp') return 'minorsPerKOp';
    if (rule === 'maxPauseMsPerOp') return 'pauseMsPerOp';
    return rule;
}

const OPS_RULES = ['maxBytesPerOp', 'maxMajorsPerKOp', 'maxMinorsPerKOp', 'maxPauseMsPerOp'];

/**
 * Gate a measureOps result against per-op rules. Verdict semantics identical
 * to checkNoGc: fail > inconclusive > pass. Returns a report; use assertOps
 * to throw instead.
 *
 * @param {ReturnType<measureOps>} result  A measureOps result object.
 * @param {object} rules                    Any subset of OPS_RULES.
 */
function checkOps(result, rules) {
    if (!result || result.schema !== OPS_SCHEMA) {
        throw new TypeError('checkOps: result must be a measureOps() result (schema lite-gc-ops/1)');
    }
    const r = rules || {};
    const violations = [];
    const checked = {};
    let anyUnchecked = false;

    for (const rule of OPS_RULES) {
        if (r[rule] === undefined) continue;
        const ok = _isCheckableOps(rule, result);
        checked[rule] = ok;
        if (!ok) { anyUnchecked = true; continue; }
        const actual = _actualPerOp(rule, result);
        if (actual > r[rule]) {
            violations.push({
                metric: _perOpMetricName(rule),
                limit: r[rule],
                actual,
                reason: _perOpMetricName(rule) + ' ' + actual.toFixed(3) + ' > ' + r[rule].toFixed(3) + ' over ' + result.ops + ' ops'
            });
        }
    }

    let verdict;
    if (violations.length > 0) verdict = 'fail';
    else if (anyUnchecked) verdict = 'inconclusive';
    else verdict = 'pass';

    return {
        kind: 'ops',
        verdict,
        checked,
        violations,
        ok: verdict === 'pass',                     // v1.0.0-shape convenience
        ops: result.ops,
        opsPerSec: result.opsPerSec,
        bytesPerOp: result.bytesPerOp,
        source: result.source,
        summary: result.summary
    };
}

/**
 * Convenience: measure and gate in one call. Throws GcBudgetError on fail,
 * GcInconclusiveError on inconclusive (unless options.allowInconclusive).
 *
 * @param {(i: number) => any} fn
 * @param {object} rules
 * @param {object} opts     Same as measureOps opts, plus optional allowInconclusive.
 */
function assertOps(fn, rules, opts) {
    const result = measureOps(fn, opts);
    const report = checkOps(result, rules);
    if (report.verdict === 'fail') {
        throw new GcBudgetError(report);
    }
    if (report.verdict === 'inconclusive' && !(opts && opts.allowInconclusive)) {
        throw new GcInconclusiveError(report);
    }
    return report;
}

// Delta rule names -- mirror maxExtra* on compareGc.
const COMPARE_OPS_RULES = {
    maxExtraBytesPerOp:   'maxBytesPerOp',
    maxExtraMajorsPerKOp: 'maxMajorsPerKOp',
    maxExtraMinorsPerKOp: 'maxMinorsPerKOp',
    maxExtraPauseMsPerOp: 'maxPauseMsPerOp'
};

/**
 * Compare two measureOps results. Rule shape: maxExtra*PerOp -- the maximum
 * allowed delta of candidate over control.
 *
 * Convenience form: compareOps(controlFn, candidateFn, rules, opts) --
 * detected via typeof of the first argument. Runs measureOps twice with
 * matched opts, then compares. The primitive form (two results) is preferred
 * for scripted benchmarks where users want to keep the raw results around.
 *
 * Source mismatch between control and candidate -> inconclusive with
 * reason: 'source_mismatch'. Consistent with compareGc.
 */
function compareOps(controlOrFn, candidateOrFn, rules, opts) {
    // Convenience form: two functions -> measure both with matched opts.
    if (typeof controlOrFn === 'function' && typeof candidateOrFn === 'function') {
        const control = measureOps(controlOrFn, opts);
        const candidate = measureOps(candidateOrFn, opts);
        return _compareOpsResults(control, candidate, rules);
    }
    // Primitive form: two results.
    return _compareOpsResults(controlOrFn, candidateOrFn, rules);
}

function _compareOpsResults(control, candidate, rules) {
    if (!control || control.schema !== OPS_SCHEMA) {
        throw new TypeError('compareOps: control must be a measureOps() result');
    }
    if (!candidate || candidate.schema !== OPS_SCHEMA) {
        throw new TypeError('compareOps: candidate must be a measureOps() result');
    }
    if (control.source !== candidate.source) {
        return {
            kind: 'compareOps',
            verdict: 'inconclusive',
            reason: 'source_mismatch',
            checked: {}, violations: [],
            ok: false,
            control, candidate
        };
    }
    const r = rules || {};
    const violations = [];
    const checked = {};
    let anyUnchecked = false;

    for (const deltaRule in COMPARE_OPS_RULES) {
        if (r[deltaRule] === undefined) continue;
        const baseRule = COMPARE_OPS_RULES[deltaRule];
        const ok = _isCheckableOps(baseRule, control) && _isCheckableOps(baseRule, candidate);
        checked[deltaRule] = ok;
        if (!ok) { anyUnchecked = true; continue; }
        const cActual = _actualPerOp(baseRule, candidate);
        const ctlActual = _actualPerOp(baseRule, control);
        const delta = cActual - ctlActual;
        if (delta > r[deltaRule]) {
            violations.push({
                metric: _perOpMetricName(baseRule) + '.delta',
                limit: r[deltaRule],
                actual: delta,
                reason: 'extra ' + _perOpMetricName(baseRule) + ': ' + delta.toFixed(3) + ' > ' + r[deltaRule].toFixed(3)
            });
        }
    }

    let verdict;
    if (violations.length > 0) verdict = 'fail';
    else if (anyUnchecked) verdict = 'inconclusive';
    else verdict = 'pass';

    return {
        kind: 'compareOps',
        verdict,
        checked, violations,
        ok: verdict === 'pass',
        control, candidate
    };
}

/**
 * Assert form of compareOps. Same throw semantics as assertOps.
 */
function assertCompareOps(controlOrFn, candidateOrFn, rules, opts) {
    const report = compareOps(controlOrFn, candidateOrFn, rules, opts);
    if (report.verdict === 'fail') {
        throw new GcBudgetError(report);
    }
    if (report.verdict === 'inconclusive' && !(opts && opts.allowInconclusive)) {
        throw new GcInconclusiveError(report);
    }
    return report;
}

// =============================================================================
// Batch 7 (v1.4.0) -- per-frame primitives (G17/G18).
//
// measureFrames drives a scheduler (raf, self-correcting setTimeout polyfill,
// or an injected function for deterministic tests) through W warmup + F
// steady frames, calling `fn(i)` per frame. Returns a Promise -- frames are
// inherently async, and awaiting gc.settle() at the boundary gives us
// reliable GC-event delivery that the sync ops path can't do.
//
// bytesPerFrame has two paths:
//   Stabilized (default when globalThis.gc is available): a forced full GC
//   at each steady boundary makes the start/end heap reads compacted live
//   sets, and bytesPerFrame is their delta over the frame count. Clean
//   workloads read ~0, real leaks read their true retained rate, and the
//   figure is stable cold-vs-warm because both ends are live sets rather
//   than raw heapUsed. The forced collections are attributed to the
//   'stabilize' phase, so steady-phase kind rules stay clean.
//   Fallback (no forceable GC, e.g. a browser without --expose-gc, or
//   stabilize:false): a retention-aware slope over ~32 periodic samples,
//   fitting LSQ through post-GC-drop anchors. Best-effort -- a per-frame
//   scheduler's own transient churn sits on top of the signal, so this
//   path carries a noise floor and is flagged bytesPerFrameStable:false.
//   Prefer a threshold above that floor when gating unstabilized results.
//
// asyncResidual: bytes the heap grew AFTER gc.settle() returned. Non-zero
// signals that the workload spawned work outlasting the frame -- not a
// gate rule, just a free smoke detector. Interleaved-async attribution
// (Fable's D12) is a v1.5.0 concurrency-lane concern; this is the
// minimum-viable warning.
// =============================================================================

/**
 * Compute a retention-aware slope over heap samples during steady phase.
 * The naive LSQ fit on raw samples is fooled by mid-run GC events: a
 * minor or major collection drops heapUsed sharply, LSQ averages that
 * drop against subsequent rises, and a real leak's slope collapses to
 * zero or negative.
 *
 * The retention pattern in the sample series is: rise (allocation),
 * drop (GC), rise, drop, rise -- with the POST-DROP samples ("local
 * minima") slowly climbing over time if retention is accumulating.
 * For a purely transient workload, the local minima stay flat.
 *
 * Algorithm:
 *   1. Walk samples. A sample is a "post-drop" anchor if it dropped
 *      by more than a threshold (0.8x) from the previous sample -- that
 *      marks the boundary where V8 just ran a collection.
 *   2. The first sample is always an anchor (pre-loop baseline).
 *   3. The final sample is always an anchor (post-settle, definitive
 *      retention endpoint).
 *   4. Fit LSQ through the anchors. Slope reflects retention accumulation
 *      rate across GC boundaries.
 *
 * Fallbacks:
 *   - If no drops detected (short measurement, non-allocating workload),
 *     the anchor set is just [first, last] and slope is the two-point
 *     delta -- honest for that case.
 *   - Scratch buffers (anchorValues, anchorXs) preallocated by the caller
 *     so this stays allocation-free.
 */
function _retentionSlope(samples, count, anchorValues, anchorXs) {
    if (count < 2) return 0;
    let anchorCount = 0;
    anchorValues[anchorCount] = samples[0];            // baseline anchor
    anchorXs[anchorCount] = 0;
    anchorCount++;
    for (let i = 1; i < count; i++) {
        if (samples[i] < samples[i - 1] * 0.8) {
            // Sharp drop -- V8 ran a collection between samples[i-1] and samples[i].
            // samples[i] is the post-collection live set at that x.
            anchorValues[anchorCount] = samples[i];
            anchorXs[anchorCount] = i;
            anchorCount++;
        }
    }
    // Force the last sample as an anchor if it isn't already -- that's the
    // post-settle definitive endpoint.
    if (anchorXs[anchorCount - 1] !== count - 1) {
        anchorValues[anchorCount] = samples[count - 1];
        anchorXs[anchorCount] = count - 1;
        anchorCount++;
    }
    if (anchorCount < 2) return 0;
    // LSQ over irregular x's. Slope = (N*Sxy - Sx*Sy) / (N*Sxx - Sx*Sx).
    const N = anchorCount;
    let Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
    for (let i = 0; i < N; i++) {
        const x = anchorXs[i];
        const y = anchorValues[i];
        Sx  += x;
        Sy  += y;
        Sxx += x * x;
        Sxy += x * y;
    }
    const denom = N * Sxx - Sx * Sx;
    if (denom === 0 || !Number.isFinite(denom)) return 0;
    const slope = (N * Sxy - Sx * Sy) / denom;
    return Number.isFinite(slope) ? slope : 0;
}

/**
 * Compute p50/p95/p99/max of workTimes[0..count-1]. Uses a preallocated
 * scratch Float64Array to avoid allocating a copy in the hot path exit.
 * The scratch is sorted in-place after copying values in.
 */
function _framePercentiles(workTimes, count, scratch) {
    if (count <= 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
    for (let i = 0; i < count; i++) scratch[i] = workTimes[i];
    // Float64Array.sort is in-place; TimSort in V8. One-off cost at result
    // assembly, not per-frame.
    scratch.subarray(0, count).sort();
    const p50 = scratch[Math.floor(count * 0.50)];
    const p95 = scratch[Math.min(count - 1, Math.floor(count * 0.95))];
    const p99 = scratch[Math.min(count - 1, Math.floor(count * 0.99))];
    const max = scratch[count - 1];
    return { p50, p95, p99, max };
}

const DEFAULT_FRAME_BUDGET_MS = 1000 / 60;

/**
 * Build a self-correcting setTimeout pacer aiming for `targetMs` cadence.
 * Drift-compensating: if the previous callback ran late, shortens the next
 * delay so we don't accumulate lag. Bounded at 0 -- we never call
 * setTimeout with a negative delay.
 *
 * Not sub-millisecond precise (setTimeout isn't), but honest for the
 * headless polyfill role: ~16.67ms cadence within setTimeout's own noise
 * floor. Users who need real rAF should run in a browser.
 */
function _createPolyfillScheduler(targetMs) {
    let last = (typeof performance !== 'undefined' ? performance : { now: Date.now }).now();
    return function schedule(cb) {
        const perf = typeof performance !== 'undefined' ? performance : { now: Date.now };
        const now = perf.now();
        const drift = now - last;
        const delay = drift >= targetMs ? 0 : targetMs - drift;
        return setTimeout(function () {
            last = perf.now();
            cb();
        }, delay);
    };
}

/**
 * Resolve the scheduler option to a `(cb) => handle` function. Auto-detect
 * (default): requestAnimationFrame if available, else the polyfill pacer.
 * Explicit strings 'raf' and 'polyfill' force a specific path. A function
 * value is used directly -- the D14 escape hatch for injected/deterministic
 * schedulers in tests.
 *
 * Throws RangeError on 'raf' explicit request when requestAnimationFrame
 * is not available (headless node without a DOM shim). This keeps the
 * test intent honest: if you asked for raf, you get raf or an error, not
 * a silent polyfill fallback.
 */
function _resolveScheduler(schedulerOpt, budgetMs) {
    if (typeof schedulerOpt === 'function') return schedulerOpt;
    const hasRaf = typeof requestAnimationFrame === 'function';
    if (schedulerOpt === 'raf') {
        if (!hasRaf) throw new RangeError('measureFrames: opts.scheduler:"raf" requires a requestAnimationFrame implementation (browser or DOM shim)');
        return function (cb) { return requestAnimationFrame(cb); };
    }
    if (schedulerOpt === 'polyfill') {
        return _createPolyfillScheduler(budgetMs);
    }
    if (schedulerOpt === undefined || schedulerOpt === 'auto') {
        if (hasRaf) return function (cb) { return requestAnimationFrame(cb); };
        return _createPolyfillScheduler(budgetMs);
    }
    throw new TypeError('measureFrames: opts.scheduler must be "auto" | "raf" | "polyfill" | function');
}

/**
 * Run `fn(i)` across `opts.warmup` warmup frames + `opts.frames` steady
 * frames, one call per scheduler tick. Awaits any Promise returned by fn
 * before advancing. Async: returns a Promise resolving to the result.
 *
 * @param {(i: number) => any | Promise<any>} fn
 * @param {object} opts
 * @param {number} opts.frames                       Steady-phase frame count. Required, > 0.
 * @param {number} [opts.warmup=0]                   Warmup frames. Excluded from all steady stats.
 * @param {'auto'|'raf'|'polyfill'|Function} [opts.scheduler='auto']
 * @param {number} [opts.frameBudgetMs=16.67]        Work-time threshold for droppedFrames.
 * @param {'auto'|'gc'|'heap'|'uasm'|'none'} [opts.source='auto']
 * @param {number} [opts.capacity=256]               GcProfiler pause-ring capacity.
 * @returns {Promise<{
 *   schema: 'lite-gc-frames/1',
 *   frames: number, warmupFrames: number,
 *   elapsedMs: number, fps: number,
 *   bytesPerFrame: number | null,
 *   majorsPerKFrame: number, minorsPerKFrame: number,
 *   maxPauseMsPerFrame: number,
 *   droppedFrames: number,
 *   frameTimes: { p50: number, p95: number, p99: number, max: number },
 *   asyncResidual: number,
 *   source: GcSource,
 *   summary: GcSummary
 * }>}
 *
 * ## Async attribution limitation
 *
 * Unawaited microtasks or promises spawned inside fn may have their
 * allocations attributed to whatever phase is current when perf_hooks
 * delivers the GC event -- not the frame that spawned them. For a
 * cooperative fn (fully awaits its own work), attribution is accurate.
 * For fire-and-forget promise chains, `asyncResidual` in the result
 * gives a smoke signal (bytes still growing past settle). Full
 * interleaved-async attribution is a v1.5.0 concurrency-lane concern.
 */
function measureFrames(fn, opts) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('measureFrames: fn must be a function'));
    if (!opts || typeof opts !== 'object') return Promise.reject(new TypeError('measureFrames: opts is required'));
    const frames = opts.frames;
    const warmup = opts.warmup === undefined ? 0 : opts.warmup;
    if (!Number.isFinite(frames) || frames <= 0 || (frames | 0) !== frames) {
        return Promise.reject(new RangeError('measureFrames: opts.frames must be a positive integer'));
    }
    if (!Number.isFinite(warmup) || warmup < 0 || (warmup | 0) !== warmup) {
        return Promise.reject(new RangeError('measureFrames: opts.warmup must be a non-negative integer'));
    }
    const frameBudgetMs = opts.frameBudgetMs === undefined ? DEFAULT_FRAME_BUDGET_MS : +opts.frameBudgetMs;
    if (!Number.isFinite(frameBudgetMs) || frameBudgetMs <= 0) {
        return Promise.reject(new RangeError('measureFrames: opts.frameBudgetMs must be a positive finite number'));
    }

    // Stabilize mode: force a full GC at each steady-phase boundary so
    // bytesPerFrame reflects the *retained* live-set delta (bytes/frame that
    // survive collection) rather than the raw heapUsed climb, which a
    // per-frame scheduler's own transient churn inflates into a phantom
    // slope. The forced collections are attributed to the 'stabilize' phase,
    // so steady-phase gate rules (majors/minors/pause per frame) stay clean.
    //
    // Unlike the sync ops lane -- where stabilize is strictly opt-in because
    // forcing GC changes its passive default -- measureFrames is already
    // async and already awaits settle(), so anchoring the two boundaries
    // costs two collections total and makes bytesPerFrame trustworthy. It is
    // therefore ON BY DEFAULT when globalThis.gc is available (node
    // --expose-gc). stabilize:true demands it (reject if unavailable);
    // stabilize:false opts out and falls back to the slope estimate, which is
    // flagged bytesPerFrameStable:false in the result.
    const hasForceableGc = typeof globalThis.gc === 'function';
    if (opts.stabilize === true && !hasForceableGc) {
        return Promise.reject(new RangeError(
            'measureFrames: opts.stabilize:true requires node --expose-gc ' +
            '(globalThis.gc must be a function). Run: node --expose-gc ... ' +
            'or drop stabilize for slope-estimate measurement.'
        ));
    }
    const stabilize = opts.stabilize === false ? false : (opts.stabilize === true ? true : hasForceableGc);

    let schedule;
    try {
        schedule = _resolveScheduler(opts.scheduler, frameBudgetMs);
    } catch (e) {
        return Promise.reject(e);
    }

    const capacity = opts.capacity === undefined ? 256 : opts.capacity | 0;
    const source = opts.source === undefined ? 'auto' : opts.source;
    const gc = new GcProfiler(capacity, { source: source }).start();

    // Preallocated hot-path buffers -- zero alloc per frame.
    const workTimes = new Float64Array(frames);
    const percentileScratch = new Float64Array(frames);
    // Periodic heap sampling for LSQ slope. ~32 samples across steady;
    // K clamps at 1 for tiny frame counts. Preallocate one extra slot to
    // hold the final settle-boundary sample.
    const K = Math.max(1, Math.floor(frames / 32));
    const maxSamples = Math.floor(frames / K) + 2;
    const heapSamples = new Float64Array(maxSamples);
    const anchorValues = new Float64Array(maxSamples);
    const anchorXs = new Float64Array(maxSamples);
    let heapSampleCount = 0;

    const isNode = typeof process !== 'undefined' && !!process.memoryUsage;
    const canSampleMemory = source !== 'none';
    function sampleHeap() {
        if (!canSampleMemory || heapSampleCount >= maxSamples) return -1;
        let used;
        if (isNode) {
            used = process.memoryUsage().heapUsed;
        } else {
            used = _readHeapUsedFor(gc);
        }
        if (used >= 0) heapSamples[heapSampleCount++] = used;
        return used;
    }

    const perf = typeof performance !== 'undefined' ? performance : { now: Date.now };
    let steadyStartT = 0;
    let steadyEndT = 0;
    let frameIndex = 0;
    let inSteady = false;

    return new Promise(function (resolve, reject) {
        gc.phase('warmup');

        function runFrame() {
            // Phase transition on the boundary frame.
            if (frameIndex === warmup && !inSteady) {
                // Stabilized: force a full GC (attributed to 'stabilize', not
                // 'steady') so the steady-start sample is a compacted live-set
                // floor -- warmup allocation and JIT tier-up churn are collected
                // out before the retained-bytes baseline is read.
                if (stabilize) {
                    gc.phase('stabilize');
                    globalThis.gc();
                }
                gc.phase('steady');
                inSteady = true;
                sampleHeap();                                  // steady-start sample (post-GC when stabilized)
                steadyStartT = perf.now();
            }

            const t0 = perf.now();
            let ret;
            try {
                ret = fn(frameIndex);
            } catch (err) {
                gc.stop();
                reject(err);
                return;
            }

            function afterFn() {
                const t1 = perf.now();
                if (inSteady) {
                    const steadyIdx = frameIndex - warmup;
                    workTimes[steadyIdx] = t1 - t0;
                    // Periodic sample every K frames (skip idx 0 -- already sampled at boundary).
                    if (steadyIdx > 0 && steadyIdx % K === 0) sampleHeap();
                }
                frameIndex++;
                if (frameIndex < warmup + frames) {
                    schedule(runFrame);
                } else {
                    steadyEndT = perf.now();
                    finalize();
                }
            }

            if (ret && typeof ret.then === 'function') {
                ret.then(afterFn, function (err) {
                    gc.stop();
                    reject(err);
                });
            } else {
                afterFn();
            }
        }

        async function finalize() {
            // Raw steady-end heapUsed BEFORE settle and before any forced GC --
            // the baseline for asyncResidual (which must see fire-and-forget
            // growth, not a value we just collected away). Also the steady-end
            // sample for the slope-estimate fallback path.
            const preSettleUsed = (canSampleMemory && isNode) ? process.memoryUsage().heapUsed : -1;
            if (!stabilize && canSampleMemory) sampleHeap();   // steady-end sample for slope fallback
            let settleResult;
            try {
                settleResult = await gc.settle();
            } catch (err) {
                gc.stop();
                reject(err);
                return;
            }
            // asyncResidual: bytes the heap grew past settle. Signals
            // fire-and-forget work outliving the measurement window. Measured
            // on raw numbers, before the stabilize end-GC, so a forced
            // collection can't mask it.
            let asyncResidual = 0;
            if (canSampleMemory && isNode && preSettleUsed >= 0) {
                const postSettle = process.memoryUsage().heapUsed;
                asyncResidual = Math.max(0, postSettle - preSettleUsed);
            }

            // bytesPerFrame.
            //   Stabilized: post-GC live-set delta across the steady window.
            //   heapSamples[0] is the compacted steady-start floor; force one
            //   more GC now (attributed to 'stabilize', keeping steady clean)
            //   and read the compacted steady-end floor. The difference is
            //   bytes retained per frame -- clean workloads read ~0, real
            //   leaks read their true rate, and the figure is stable across
            //   cold/warm runs because both ends are live sets, not raw heap.
            //   Fallback (no forceable GC): retention-aware slope over the
            //   periodic samples -- best-effort, flagged not-stable.
            let bytesPerFrame = null;
            let bytesPerFrameStable = false;
            if (canSampleMemory) {
                if (stabilize && isNode && heapSampleCount >= 1) {
                    gc.phase('stabilize');
                    globalThis.gc();
                    const liveEnd = process.memoryUsage().heapUsed;
                    const liveStart = heapSamples[0];
                    const bpf = (liveEnd - liveStart) / frames;
                    bytesPerFrame = bpf > 0 ? bpf : 0;
                    bytesPerFrameStable = true;
                } else if (heapSampleCount >= 2) {
                    const slope = _retentionSlope(heapSamples, heapSampleCount, anchorValues, anchorXs);
                    const bpf = slope / K;
                    bytesPerFrame = bpf > 0 ? bpf : 0;
                    bytesPerFrameStable = false;
                }
            }

            const summary = gc.summary();
            gc.stop();

            // droppedFrames + percentile distribution over steady work times.
            let droppedFrames = 0;
            for (let i = 0; i < frames; i++) {
                if (workTimes[i] > frameBudgetMs) droppedFrames++;
            }
            const frameTimes = _framePercentiles(workTimes, frames, percentileScratch);

            // Per-frame GC rates come from the steady phase sub-summary.
            const steady = summary.phases.steady && summary.phases.steady.gc;
            const steadyMajor = steady ? steady.major : 0;
            const steadyMinor = steady ? steady.minor : 0;
            const steadyMaxMs = steady ? steady.maxMs : 0;
            const steadyElapsed = steadyEndT - steadyStartT;
            const fps = steadyElapsed > 0 ? (frames * 1000) / steadyElapsed : 0;

            resolve({
                schema: 'lite-gc-frames/1',
                frames: frames,
                warmupFrames: warmup,
                elapsedMs: steadyElapsed,
                fps: fps,
                bytesPerFrame: bytesPerFrame,
                bytesPerFrameStable: bytesPerFrameStable,
                majorsPerKFrame: (steadyMajor * 1000) / frames,
                minorsPerKFrame: (steadyMinor * 1000) / frames,
                maxPauseMsPerFrame: steadyMaxMs,
                droppedFrames: droppedFrames,
                frameTimes: frameTimes,
                asyncResidual: asyncResidual,
                source: gc.source,
                summary: summary,
                _settled: settleResult.drained
            });
        }

        schedule(runFrame);
    });
}

/**
 * Gate a measureFrames result against per-frame rules. Sync -- takes a
 * result, produces a report. Mirrors checkOps shape for tooling reuse.
 *
 * Rules: maxBytesPerFrame, maxMajorsPerKFrame, maxMinorsPerKFrame,
 * maxPauseMsPerFrame, maxDroppedFrames. All optional; unspecified rules
 * are skipped.
 */
function checkFrames(result, rules) {
    if (!result || result.schema !== 'lite-gc-frames/1') {
        throw new TypeError('checkFrames: result must be a measureFrames result');
    }
    if (!rules || typeof rules !== 'object') {
        throw new TypeError('checkFrames: rules must be an object');
    }
    const source = result.source;
    const violations = [];
    const checked = {};
    let sawInconclusive = false;

    function checkOne(rule, actual, metric) {
        const limit = rules[rule];
        if (limit === undefined) return;
        const row = VERDICT_MATRIX[rule];
        const state = row ? row[source] : 'no';
        if (state === 'yes' || state === 'needsHeap' || state === 'needsUasm') {
            checked[rule] = true;
            if (actual !== null && actual > limit) {
                violations.push({ rule: rule, metric: metric, actual: actual, limit: limit });
            } else if (actual === null && (state === 'needsHeap' || state === 'needsUasm')) {
                checked[rule] = false;
                sawInconclusive = true;
            }
        } else {
            checked[rule] = false;
            sawInconclusive = true;
        }
    }

    checkOne('maxBytesPerFrame', result.bytesPerFrame, 'bytesPerFrame');
    checkOne('maxMajorsPerKFrame', result.majorsPerKFrame, 'majorsPerKFrame');
    checkOne('maxMinorsPerKFrame', result.minorsPerKFrame, 'minorsPerKFrame');
    checkOne('maxPauseMsPerFrame', result.maxPauseMsPerFrame, 'maxPauseMsPerFrame');
    checkOne('maxDroppedFrames', result.droppedFrames, 'droppedFrames');

    let verdict;
    if (violations.length > 0) verdict = 'fail';
    else if (sawInconclusive) verdict = 'inconclusive';
    else verdict = 'pass';

    return {
        schema: 'lite-gc-report/1',
        kind: 'frames',
        verdict: verdict,
        source: source,
        violations: violations,
        checked: checked,
        result: result
    };
}

/**
 * Convenience: run measureFrames + checkFrames, throwing GcBudgetError on
 * fail or GcInconclusiveError on inconclusive (unless allowInconclusive).
 * Async.
 */
async function assertFrames(fn, rules, opts) {
    const result = await measureFrames(fn, opts);
    const report = checkFrames(result, rules);
    if (report.verdict === 'fail') throw new GcBudgetError(report);
    if (report.verdict === 'inconclusive' && !(opts && opts.allowInconclusive)) {
        throw new GcInconclusiveError(report);
    }
    return report;
}

/**
 * Compare two measureFrames results (or two functions) on delta rules.
 * Rules: maxExtraBytesPerFrame (candidate.bytesPerFrame - control > threshold),
 * maxExtraDroppedFrames (candidate.droppedFrames - control > threshold).
 * Async.
 */
async function compareFrames(controlOrFn, candidateOrFn, rules, opts) {
    if (!rules || typeof rules !== 'object') throw new TypeError('compareFrames: rules must be an object');
    let control, candidate;
    if (typeof controlOrFn === 'function' && typeof candidateOrFn === 'function') {
        control = await measureFrames(controlOrFn, opts);
        candidate = await measureFrames(candidateOrFn, opts);
    } else {
        if (!controlOrFn || controlOrFn.schema !== 'lite-gc-frames/1'
            || !candidateOrFn || candidateOrFn.schema !== 'lite-gc-frames/1') {
            throw new TypeError('compareFrames: expected two measureFrames results or two functions');
        }
        control = controlOrFn;
        candidate = candidateOrFn;
    }
    if (control.source !== candidate.source) {
        return {
            schema: 'lite-gc-report/1',
            kind: 'frames',
            verdict: 'inconclusive',
            reason: 'source_mismatch',
            source: candidate.source,
            control: control,
            candidate: candidate,
            violations: [],
            checked: {}
        };
    }

    const violations = [];
    const checked = {};
    let sawInconclusive = false;
    const source = candidate.source;

    if (rules.maxExtraBytesPerFrame !== undefined) {
        const row = VERDICT_MATRIX.maxBytesPerFrame;
        const state = row[source];
        if (state === 'yes' || state === 'needsHeap' || state === 'needsUasm') {
            if (control.bytesPerFrame !== null && candidate.bytesPerFrame !== null) {
                checked.maxExtraBytesPerFrame = true;
                const delta = candidate.bytesPerFrame - control.bytesPerFrame;
                if (delta > rules.maxExtraBytesPerFrame) {
                    violations.push({
                        rule: 'maxExtraBytesPerFrame', metric: 'bytesPerFrame.delta',
                        actual: delta, limit: rules.maxExtraBytesPerFrame
                    });
                }
            } else {
                checked.maxExtraBytesPerFrame = false;
                sawInconclusive = true;
            }
        } else {
            checked.maxExtraBytesPerFrame = false;
            sawInconclusive = true;
        }
    }
    if (rules.maxExtraDroppedFrames !== undefined) {
        // Source-agnostic, like maxDroppedFrames itself.
        checked.maxExtraDroppedFrames = true;
        const delta = candidate.droppedFrames - control.droppedFrames;
        if (delta > rules.maxExtraDroppedFrames) {
            violations.push({
                rule: 'maxExtraDroppedFrames', metric: 'droppedFrames.delta',
                actual: delta, limit: rules.maxExtraDroppedFrames
            });
        }
    }

    let verdict;
    if (violations.length > 0) verdict = 'fail';
    else if (sawInconclusive) verdict = 'inconclusive';
    else verdict = 'pass';

    return {
        schema: 'lite-gc-report/1',
        kind: 'frames',
        verdict: verdict,
        source: source,
        violations: violations,
        checked: checked,
        control: control,
        candidate: candidate
    };
}

/**
 * Convenience: compareFrames + throw on fail/inconclusive. Async.
 */
async function assertCompareFrames(controlOrFn, candidateOrFn, rules, opts) {
    const report = await compareFrames(controlOrFn, candidateOrFn, rules, opts);
    if (report.verdict === 'fail') throw new GcBudgetError(report);
    if (report.verdict === 'inconclusive' && !(opts && opts.allowInconclusive)) {
        throw new GcInconclusiveError(report);
    }
    return report;
}


export {
    VERSION,
    GcProfiler,
    checkNoGc, assertNoGc,
    compareGc, assertCompare,
    aggregateGc, gateReps, assertReps,
    captureFingerprint, createBaseline, checkAgainstBaseline, assertAgainstBaseline,
    formatConsole, formatJson, formatMarkdown, formatGithubAnnotations,
    // Batch 6 (v1.3.0) -- per-op primitives.
    measureOps, checkOps, assertOps,
    compareOps, assertCompareOps,
    // Batch 7 (v1.4.0) -- per-frame primitives.
    measureFrames, checkFrames, assertFrames,
    compareFrames, assertCompareFrames,
    GcBudgetError, GcInconclusiveError,
    GC_DEFAULT_RULES, GC_DEFAULT_DIFFERENTIAL_RULES, REP_POLICY_DEFAULTS,
    VERDICT_MATRIX,
    GC_MINOR, GC_MAJOR, GC_INCREMENTAL, GC_WEAKCB
};
