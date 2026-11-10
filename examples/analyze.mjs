import { openAsBlob } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeReport } from '@fuzzinghero/partitioner/core';

const path = process.argv[2] ?? fileURLToPath(new URL('./partition-report.har', import.meta.url));
const report = await analyzeReport(await openAsBlob(path));
console.log(JSON.stringify(report, null, 2));
