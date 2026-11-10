# @fuzzinghero/partitioner

Group similar HTTP responses in HAR files and inspect the request inputs associated with each group. Learn more in Fuzzing Hero’s [partition documentation](https://fuzzinghero.com/docs/concepts/response-partitions).

Analysis runs locally with no network requests or runtime dependencies. Includes a Node.js CLI, browser worker client and optional React hook. Grouping is heuristic; original captured evidence remains available for inspection.

## Install

```sh
npm install @fuzzinghero/partitioner
```

ESM. Requires Node.js 22.18+ or a modern browser.

## Node.js

```js
import { openAsBlob } from 'node:fs';
import { analyzeReport } from '@fuzzinghero/partitioner/core';

const report = await analyzeReport(await openAsBlob('./capture.har'));
console.log(JSON.stringify(report, null, 2));
```

The JSON report contains request contexts, response partitions, sample exchanges and observed input variations. To try a small synthetic capture, see [examples](examples).

## CLI

```sh
npx @fuzzinghero/partitioner --file capture.har > report.json
```

From a source checkout, `node bin/partitioner.mjs --file capture.har` works without a build. Use `--help` for options.

## Browser

```js
import { createAnalyzer } from '@fuzzinghero/partitioner/browser';

const analyzer = createAnalyzer();
try {
  await analyzer.analyze(file); // A HAR File or Blob.
  const partitions = await analyzer.getPartitions();
  console.log(partitions);
} finally {
  analyzer.dispose();
}
```

Keep the analyzer alive while querying results. It also provides `getContexts`, `getMembers`, `getEntry`, `getRequestChanges` and `compare`.

For Vite, supply a bundled worker:

```js
import AnalyzerWorker from '@fuzzinghero/partitioner/worker?worker';

const analyzer = createAnalyzer({ createWorker: () => new AnalyzerWorker() });
```

## Entry points

| Import                             | Purpose                                |
| ---------------------------------- | -------------------------------------- |
| `@fuzzinghero/partitioner`         | Shared types, constants and errors     |
| `@fuzzinghero/partitioner/core`    | Analysis, JSON reports and comparisons |
| `@fuzzinghero/partitioner/browser` | Worker client                          |
| `@fuzzinghero/partitioner/react`   | `useAnalyzer` hook for React 18 or 19  |
| `@fuzzinghero/partitioner/worker`  | Worker entry for bundlers              |

Render captured content as text and redact secrets before sharing HARs or reports. Input differences describe observed associations, not proof of causation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and change guidelines.

## License

[MIT](LICENSE). Free to use, modify and distribute, provided as-is without warranty.
