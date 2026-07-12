// @zakkster/lite-gc-profiler/explain
//
// Explain mode: heap allocation profiling via node:inspector's
// HeapProfiler.startSampling. Node-only.
//
// STRICT OPT-IN. Never active during a normal gated run -- the sampler
// perturbs the very thing it measures. Explain mode is for AFTER a gate
// fails, when you want to know WHICH allocation stacks caused the pressure.
//
// The attribution disclaimer: this answers "who allocated," which is not the
// same as "where the pause fired." Region attribution (G10) is firing-site;
// explain mode is allocator-site. Both are useful; neither substitutes for
// the other.

import { Session } from 'node:inspector';

const DEFAULT_INTERVAL_BYTES = 512 * 1024;                  // 512 KB sampling interval

/**
 * Start heap allocation sampling. Returns a handle with .stop() that yields
 * top allocation stacks.
 *
 * @param {{ intervalBytes?: number, topN?: number }} [options]
 *   intervalBytes: bytes between samples (default 512 KB). Smaller = more
 *                  detail, more perturbation.
 *   topN:          how many top stacks to include in the report (default 10).
 * @returns {ExplainHandle}
 */
function startExplainSampling(options) {
    const opts = options || {};
    const intervalBytes = opts.intervalBytes > 0 ? opts.intervalBytes : DEFAULT_INTERVAL_BYTES;
    const topN = opts.topN > 0 ? opts.topN : 10;

    const session = new Session();
    session.connect();

    // Wrap the callback-shaped inspector API in a Promise for ergonomic use.
    function post(method, params) {
        return new Promise((resolve, reject) => {
            session.post(method, params, (err, result) => {
                if (err) reject(err); else resolve(result);
            });
        });
    }

    let started = false;
    let stopped = false;

    const startPromise = post('HeapProfiler.startSampling', {
        samplingInterval: intervalBytes
    }).then(() => { started = true; });

    return {
        started: startPromise,
        /**
         * Stop sampling and return top allocation stacks.
         * @returns {Promise<{ topStacks: Array<{ selfSize: number, functionName: string, url: string, lineNumber: number }>, samplingInterval: number, topN: number }>}
         */
        stop() {
            if (stopped) return Promise.resolve({ topStacks: [], samplingInterval: intervalBytes, topN, error: 'already stopped' });
            stopped = true;
            return startPromise.then(() => {
                if (!started) return { topStacks: [], samplingInterval: intervalBytes, topN, error: 'never started' };
                return post('HeapProfiler.stopSampling').then((res) => {
                    session.disconnect();
                    return { topStacks: _extractTopStacks(res.profile, topN), samplingInterval: intervalBytes, topN };
                });
            });
        }
    };
}

// Walk the sampling profile's node tree, sum selfSize per node, sort, return
// top N with call-site info. The profile is a tree of {callFrame, selfSize,
// children[]}; selfSize is bytes allocated at this frame directly.
function _extractTopStacks(profile, topN) {
    const flat = [];
    function visit(node) {
        if (node.selfSize > 0) {
            const cf = node.callFrame || {};
            flat.push({
                selfSize: node.selfSize,
                functionName: cf.functionName || '(anonymous)',
                url: cf.url || '(unknown)',
                lineNumber: cf.lineNumber || 0,
                columnNumber: cf.columnNumber || 0
            });
        }
        if (node.children) for (const c of node.children) visit(c);
    }
    visit(profile.head);
    flat.sort((a, b) => b.selfSize - a.selfSize);
    return flat.slice(0, topN);
}

/**
 * Format an explain report as human-readable console output.
 */
function formatExplainConsole(explainResult) {
    if (explainResult.error) {
        return 'Explain: error: ' + explainResult.error;
    }
    const lines = ['Top allocation stacks (interval=' + explainResult.samplingInterval + ' bytes):'];
    if (explainResult.topStacks.length === 0) {
        lines.push('  (no samples captured)');
        return lines.join('\n');
    }
    let maxNameLen = 0;
    for (const s of explainResult.topStacks) {
        if (s.functionName.length > maxNameLen) maxNameLen = s.functionName.length;
    }
    if (maxNameLen > 40) maxNameLen = 40;
    for (const s of explainResult.topStacks) {
        const bytes = s.selfSize;
        const kb = (bytes / 1024).toFixed(1);
        const name = s.functionName.length > 40 ? s.functionName.slice(0, 37) + '...' : s.functionName;
        const paddedName = name + ' '.repeat(Math.max(0, maxNameLen - name.length));
        const loc = s.url + ':' + s.lineNumber;
        lines.push('  ' + paddedName + '  ' + kb.padStart(8) + ' KB   ' + loc);
    }
    return lines.join('\n');
}

export { startExplainSampling, formatExplainConsole };
