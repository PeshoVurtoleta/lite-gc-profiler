// A target whose report file ends up truncated.
//
// Register.mjs installs its own exit hook to write the report, and it is
// imported first, so its handler runs first. This fixture registers a LATER
// handler that clobbers the file with a half-written object -- the shape a
// process killed mid-flush, a full disk, or a concurrent writer leaves behind.
// The gate's existsSync check passes and JSON.parse then throws.
//
// The pin is that this becomes exit 3 naming the parse failure. A gate that
// reads an unparseable report as "no complaints" is the fail-open shape the
// whole suite exists to prevent.
import { writeFileSync } from 'node:fs';

process.on('exit', () => {
    const path = process.env.LITE_GC_GATE_REPORT_PATH;
    if (path) {
        try { writeFileSync(path, '{"schema":"lite-gc/1","gc":{"count":3,', 'utf8'); }
        catch { /* nothing useful to do at exit */ }
    }
});
