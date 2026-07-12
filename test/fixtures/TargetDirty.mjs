// Leaky workload: allocates aggressively to force major GC.
const buckets = [];
for (let i = 0; i < 500; i++) {
    const arr = new Array(1000);
    for (let j = 0; j < 1000; j++) arr[j] = { x: j, y: j * 2, s: 'x' + j + '-' + i };
    buckets.push(arr);
    if (i % 50 === 0 && global.gc) global.gc();
}
process.exitCode = buckets.length === -1 ? 1 : 0;
