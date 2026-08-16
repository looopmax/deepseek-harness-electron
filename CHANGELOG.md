# Changelog

All notable changes to this project are documented in this file. Releases follow [Semantic Versioning](https://semver.org/).

## [0.1.3] - 2026-08-16

### Fixed
- Windows: fixed the huge (1.6 GB) portable zip by packaging the harness as a symlink-free hoisted pnpm install instead of dereferencing the pnpm symlink graph during archive creation. The Windows zip is now comparable to the macOS/Linux artifacts.
- Windows: the packaged harness now includes real `node_modules/@deepseek-ai/*` package directories, so dynamic bare-specifier resolution keeps working without symlinks.

## [0.1.2] - 2026-08-16

### Fixed
- Packaged runtime now keeps `@mixmark-io/domino` (required by `turndown` in `@deepseek-ai/dsh-tool-web`). Session creation with the standard agent preset no longer fails with `Cannot find module '@mixmark-io/domino'`.

## [0.1.1] - 2026-08-16

### Added
- First GitHub Release with all three desktop platforms.

### Changed
- Windows is packaged as a portable zip.

## [0.1.0] - 2026-08-15

### Added
- Initial desktop shell release for macOS and Linux.
