# Contributing

Use Node.js 26 LTS and npm. CI runs one verification job on Node.js 26.

```sh
npm ci
npm run format:check
npm run lint
npm test
npm run test:package
```

`test:package` checks the installed npm archive, types, CLI, native browser workers and a Vite build. It uses Google Chrome by default. To use Chromium instead:

```sh
npx playwright-core install chromium
PARTITIONER_BROWSER=chromium npm run test:package
```

Use `npm run format` to format changes and `npm run build` to build the package. `npm run example` runs the synthetic HAR example. Optional file-backed benchmarks live in `scripts/benchmark.mjs`.

## Making changes

- Keep pull requests focused. Describe the problem, resulting behavior and checks run; discuss substantial changes in an issue first.
- Prefer straightforward code and shared parsing helpers. Keep processing local, dependency-free and bounded in work and memory.
- Preserve captured evidence. Distinguish missing data from empty values, and keep grouping rules independent of application-specific keys.
- Add realistic regression tests beside the owning module, named `<module>.test.ts`. Assert production behavior with independent expectations, including malformed input and resource limits when relevant.
- Use synthetic, sanitized fixtures. Never commit credentials or private captures.

The analysis pipeline starts in `src/analyze.ts`; grouping lives in `src/structural-analysis.ts`, `src/cohort-slots.ts` and `src/partition.ts`.

Before a release, run the checks above and inspect `npm pack --dry-run`. Publishing is a maintainer action.
