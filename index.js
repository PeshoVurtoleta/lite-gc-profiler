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

function pow2(n) { let p = 1; while (p < n) p <<= 1; return p < 1 ? 1 : p; }

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
     * @param {{ heap?: boolean, autoStart?: boolean }} [options]
     */
    constructor(capacity = 256, options = {}) {
        if (!(capacity > 0) || !isFinite(capacity)) {
            throw new RangeError('GcProfiler: capacity must be a positive finite number');
        }
        this._dur = new DurationRing(capacity);
        this._scratch = new Float64Array(this._dur.cap);

        this._count = 0; this._sumMs = 0; this._maxMs = 0;
        this._minor = 0; this._major = 0; this._incremental = 0; this._weakcb = 0;

        // heap sampling (browser, or explicit usedBytes elsewhere)
        this._heapActive = false;
        this._heapPrev = -1; this._heapPeak = 0; this._heapFirst = -1; this._heapSamples = 0;
        this._allocBytes = 0; this._gcDrops = 0; this._freedBytes = 0;
        this._tPrev = -1; this._elapsedMs = 0;

        // frame anomaly heuristic
        this._frames = 0; this._longFrames = 0; this._frameEwma = 0;

        this._obs = null; this._running = false;
        this._wantHeap = options.heap !== false;
        if (options.autoStart) this.start();
    }

    get supported() { return GC_SUPPORTED || HEAP_SUPPORTED; }
    /** Which signal is live: 'gc' (precise), 'heap' (Chrome heuristic), or 'none'. */
    get source() { return GC_SUPPORTED ? 'gc' : (HEAP_SUPPORTED ? 'heap' : 'none'); }
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
                self._record(kind, e.duration);
            }
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

    _record(kind, durationMs) {
        this._dur.push(durationMs);
        this._count++; this._sumMs += durationMs;
        if (durationMs > this._maxMs) this._maxMs = durationMs;
        if (kind === GC_MINOR) this._minor++;
        else if (kind === GC_MAJOR) this._major++;
        else if (kind === GC_INCREMENTAL) this._incremental++;
        else if (kind === GC_WEAKCB) this._weakcb++;
    }

    /** Inject a GC event directly (tests, or a custom source). */
    record(kind, durationMs) { this._record(kind | 0, +durationMs || 0); return this; }

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
            frames: { count: this._frames, long: this._longFrames }
        };
        if (meta) for (const k in meta) if (!(k in s)) s[k] = meta[k];
        return s;
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
        // the frame anomaly heuristic is windowed too
        this._frames = 0; this._longFrames = 0; this._frameEwma = 0;
    }

    destroy() { this.stop(); this._dur = null; this._scratch = null; return this; }
}

// ---- budget gate ----
const GC_DEFAULT_RULES = { maxMajor: 0 };   // any full-heap GC in the window is a failure

function checkNoGc(summary, rules) {
    const r = rules || GC_DEFAULT_RULES;
    const g = summary.gc;
    const violations = [];
    if (r.maxMajor !== undefined && g.major > r.maxMajor)
        violations.push({ metric: 'gc.major', limit: r.maxMajor, actual: g.major, reason: g.major + ' major GC(s) > ' + r.maxMajor });
    if (r.maxMinor !== undefined && g.minor > r.maxMinor)
        violations.push({ metric: 'gc.minor', limit: r.maxMinor, actual: g.minor, reason: g.minor + ' minor GC(s) > ' + r.maxMinor });
    if (r.maxPauseMs !== undefined && g.maxMs > r.maxPauseMs)
        violations.push({ metric: 'gc.maxMs', limit: r.maxPauseMs, actual: g.maxMs, reason: 'max GC pause ' + g.maxMs.toFixed(3) + 'ms > ' + r.maxPauseMs + 'ms' });
    if (r.maxTotalMs !== undefined && g.totalMs > r.maxTotalMs)
        violations.push({ metric: 'gc.totalMs', limit: r.maxTotalMs, actual: g.totalMs, reason: 'total GC ' + g.totalMs.toFixed(3) + 'ms > ' + r.maxTotalMs + 'ms' });
    if (r.maxAllocRate !== undefined && summary.heap.allocRateBytesPerSec > r.maxAllocRate)
        violations.push({ metric: 'heap.allocRateBytesPerSec', limit: r.maxAllocRate, actual: summary.heap.allocRateBytesPerSec, reason: 'alloc rate ' + (summary.heap.allocRateBytesPerSec / 1048576).toFixed(2) + 'MB/s > ' + (r.maxAllocRate / 1048576).toFixed(2) + 'MB/s' });
    return { ok: violations.length === 0, violations, source: summary.source };
}

class GcBudgetError extends Error {
    constructor(report) {
        super('GC budget exceeded: ' + report.violations.map((v) => v.reason).join('; '));
        this.name = 'GcBudgetError';
        this.report = report;
    }
}

function assertNoGc(summary, rules) {
    const rep = checkNoGc(summary, rules);
    if (!rep.ok) throw new GcBudgetError(rep);
    return rep;
}

export {
    GcProfiler,
    checkNoGc, assertNoGc, GcBudgetError, GC_DEFAULT_RULES,
    GC_MINOR, GC_MAJOR, GC_INCREMENTAL, GC_WEAKCB
};
