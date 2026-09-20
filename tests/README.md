# Test layout

- `apps/*/src/` and `packages/*/src/` contain implementation code.
- `apps/*/tests/` and `packages/*/tests/` contain each workspace's unit tests. Tests import the workspace's
  compiled modules from `../dist/`, including internal modules when needed.
- Each workspace's `tsconfig.test.json` builds tests into its ignored local
  `build/` directory and references the product build. Product exports remain in
  `dist/`.
- This root `tests/` directory contains the test runner, integration and smoke
  journeys, platform acceptance scripts, and their supporting fixtures.

Run `npm test` to build and execute all unit tests, or `npm run check` for the full
deterministic check sequence. The runner discovers current test sources and runs
their corresponding compiled files; obsolete build artifacts are not discovered
as tests. Platform smoke and live-provider commands remain separate npm scripts.
