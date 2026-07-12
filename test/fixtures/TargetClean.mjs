// Clean workload: pooled loop, zero allocations, should produce pass verdict.
const buf = new Float64Array(1024);
for (let i = 0; i < 100000; i++) buf[i & 1023] = i * 0.5;
// Keep-alive so V8 doesn't dead-code-eliminate the loop
process.exitCode = buf[0] === -1 ? 1 : 0;
