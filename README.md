# Candy

Candy is a standalone, DeepSeek-first coding product for macOS Sequoia 15+ and Windows 11.

## Development baseline

- Node.js `22.23.2`
- npm `10.9.8`
- TypeScript `5.9.3`
- Pi package family `0.84.1`

Use the exact Node/npm pair before installing dependencies:

```powershell
nvm use 22.23.2
npm ci --ignore-scripts
npm run check
```

Windows development-machine setup, native prerequisites, and executable audit instructions are in [`docs/development/windows-11-toolchain.md`](docs/development/windows-11-toolchain.md).

Product scope is defined in `docs/product/candy-v1.md`. Implementation order and evidence requirements are defined in `docs/architecture/implementation-plan-v1.md` and `docs/product/acceptance-v1.md`.

Development machine setup:

- Windows 11: `docs/development/windows-11-toolchain.md`
- macOS Sequoia 15+ / Apple Silicon: `docs/development/macos-sequoia-toolchain.md`
