# Pi-Compatible Toolchain Baseline

- Status: **accepted design baseline; clean-install and packaged-runtime smoke tests pending**
- Reviewed: **2026-08-09**
- Compatibility anchor: **Pi `v0.84.1`**

## Decision

Candy does not select Node.js, npm, TypeScript, or Pi independently. Pi `0.84.1` is the compatibility anchor for the agent runtime, and the first implementation baseline is:

| Layer | Candy V1 baseline | Reason |
| --- | --- | --- |
| Agent runtime Node.js | `22.23.2` | current security-patched Node 22 LTS; Pi requires `>=22.19.0` and tests/releases on the Node 22 line |
| Package manager | `npm@10.9.8` | bundled with Node `22.23.2`; Pi's normal CI uses the npm supplied by Node 22 |
| TypeScript | `5.9.3` | exact version used by Pi `v0.84.1` |
| Module format | ESM/NodeNext; compiled JavaScript in production | Pi publishes ESM packages; no runtime TypeScript loader is required in production |
| Pi packages | every installed `@earendil-works/pi-*` package at exactly `0.84.1` | prevents a mixed Pi dependency graph |
| Locking | npm lockfile v3, one root `package-lock.json`, `npm ci` | matches Pi's npm/lockfile workflow and makes the full graph reproducible |

Electron remains independently pinned to the accepted Desktop release. Electron main and renderer use Electron's embedded Node only for Desktop responsibilities. The Candy app-server that imports the Pi Adapter runs as an app-managed child under the packaged Node `22.23.2` runtime, so TUI and Desktop execute Pi under the same Node line.

## Primary-source findings

The following facts come from the official Pi `v0.84.1` tag:

- the root and published core packages declare Node.js `>=22.19.0` and ESM;
- the root pins `typescript` to `5.9.3` and `@types/node` to `22.19.19`;
- normal CI uses `actions/setup-node` with `node-version: 22`, then `npm ci --ignore-scripts`, build, check, and test;
- the release build and pre-publish verification also use Node 22; only the final trusted-publishing step upgrades npm to `11.16.0`, which is a publisher requirement rather than a consumer runtime baseline;
- `.npmrc` enables `save-exact=true` and `min-release-age=2`;
- `package-lock.json` uses lockfile version 3;
- `@earendil-works/pi-coding-agent@0.84.1` declares its sibling Pi packages with `^0.84.1`, so an unconstrained consumer install could eventually resolve a mixed Pi package set despite directly pinning only the coding-agent package.

The official Node.js 22 archive lists `22.23.2` as the latest Node 22 release on the review date and lists its bundled npm as `10.9.8`.

Sources:

- [Pi v0.84.1 root package.json](https://github.com/earendil-works/pi/blob/v0.84.1/package.json)
- [Pi v0.84.1 CI workflow](https://github.com/earendil-works/pi/blob/v0.84.1/.github/workflows/ci.yml)
- [Pi v0.84.1 release workflow](https://github.com/earendil-works/pi/blob/v0.84.1/.github/workflows/build-binaries.yml)
- [Pi v0.84.1 npm configuration](https://github.com/earendil-works/pi/blob/v0.84.1/.npmrc)
- [Pi coding-agent package manifest](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/package.json)
- [Node.js 22 download archive](https://nodejs.org/en/download/archive/v22)

## Dependency policy

1. Use npm for Candy V1. Do not introduce pnpm, Yarn, or Bun into the application build merely for newer package resolution or workspace features.
2. Pin direct dependencies exactly. The root lockfile pins transitives. Use root npm `overrides` or equivalent install assertions to keep the complete `@earendil-works/pi-*` closure at `0.84.1`.
3. Do not override Pi's third-party transitive dependencies merely to obtain newer versions. A security or platform requirement may justify an override only after the Pi Adapter contract matrix passes with that override.
4. New Candy dependencies need not copy every Pi development dependency. They must not change the Node/ESM/TypeScript contract seen by `pi-adapter`, and they must pass a clean install plus Adapter smoke test.
5. Treat Electron's embedded Node as a different runtime. No package under `pi-adapter` may be loaded in Electron main or renderer.
6. Install and lifecycle scripts use an allowlist. CI installs from the committed lockfile and fails if installation changes it.

## Upgrade policy

Pi and its boundary-sensitive toolchain move as one compatibility train:

1. select an exact candidate Pi release;
2. inspect that tag's engine, TypeScript, package-manager, lockfile, CI, release, and public-export contracts;
3. choose a security-patched Node release from the major line that Pi tests, and use its bundled npm unless a documented Pi consumer requirement says otherwise;
4. regenerate the Candy lockfile once and verify that every installed Pi package has the selected exact version;
5. run clean install, public import, session create/reload, tool hook, cancellation, provider streaming, and process-exit tests on Windows 11 and the current macOS Tahoe `26.x` Apple Silicon host; retain exact `26.5.2` regression coverage when that compatibility claim is required;
6. run the same Pi Adapter suite in both TUI and packaged Desktop app-server topology;
7. update Pi, Node/npm/TypeScript baselines, the lockfile, and compatibility evidence together.

A Node major change, npm major change, TypeScript minor/major change, any Pi version change, or any Pi transitive override reopens this Gate. A security patch within the selected Node 22 line may be adopted after the same automated compatibility suite passes.

## Acceptance checks

The baseline is accepted for implementation only when:

- `node --version`, `npm --version`, and `tsc --version` report the pinned values in the source-build environment;
- `npm ci` succeeds from a clean checkout on both supported platforms without modifying `package-lock.json`;
- an install-tree assertion proves every `@earendil-works/pi-*` package is exactly `0.84.1` and reports no invalid peer/dependency state;
- only `packages/pi-adapter` imports Pi packages or Pi types;
- the same Adapter contract suite passes in TUI and packaged Desktop app-server processes;
- Electron main/renderer package graphs contain no Pi import;
- a deliberately mismatched Pi package or unsupported Node version fails before a task starts with an actionable compatibility error.
