# Changelog

What has landed **in this mirror**, newest first.

This is not a release log: nothing is published from this repository, and `@stigg/agent-sdk-js` on
npm is versioned and released by Stigg internally. What is recorded here is what arrived - each sync
names the upstream commit it came from, so a reader can tell what they are looking at and when it
changed.

## Unreleased

### Added

- The repository itself: Yarn 4 through Corepack, ESLint and Prettier in the configuration the SDK
  is written against, a single CI job, and the guards in `tools/repo-tests` that keep the mirror
  honest.
- `.sync-manifest.json` - the contract for what crosses between this repository and the one the
  SDK is developed in. Where a sync came from is recorded in its commit trailer, not in a file.

### Notes

- The SDK source has not arrived yet. It lands in the first sync, and this file gets its first real
  entry then.
- The manifest tracks the upstream version (`0.1.0`) rather than a version of its own.
