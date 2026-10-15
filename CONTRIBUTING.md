# Contributing

Thanks for looking. A few things are worth knowing before you spend time here, because this
repository is not shaped like most.

## This is a mirror

The SDK is developed in Stigg's internal monorepo and mirrored here, file for file. That has two
consequences for a pull request:

- **It still travels - by hand, for now.** Changes are carried _outward_ from the internal
  repository by an agent working from `.sync-manifest.json`. Nothing yet carries a change the other
  way: a pull request accepted here is reviewed, then applied inward by a maintainer. The fix does
  reach the published package; it is not a button yet.
- **Everything under the mirror has rules.** `.sync-manifest.json` says which paths mirror, which
  three files are transformed on the way across, and which belong to this repository alone. A pull
  request that ignores it fails CI rather than surprising someone later.

## Running it

Node.js 22 or later.

```sh
corepack enable          # Node 25 and later: npm install -g corepack first
yarn install
yarn test
```

[Corepack](https://github.com/nodejs/corepack) pins Yarn to the version in `packageManager`. It
shipped with Node from 14.19 and was unbundled in Node 25, so on newer versions install it first.

`yarn lint`, `yarn format` and `yarn typecheck` do what they say, and CI runs exactly those plus
`yarn test`, so a green local run is a green pull request. `yarn build` needs the SDK source - its
config is mirrored and arrives with the first sync.

## What will get a change sent back

- **Reformatting mirrored code.** `.prettierrc` and `eslint.config.mjs` are the internal
  configuration verbatim. Changing them reformats the whole package on the next sync and buries
  whatever the change was actually about. If a rule is wrong, say so in an issue - it has to change
  on both sides at once.
- **A new top-level path nobody classified.** `yarn test:repo` fails until `.sync-manifest.json`
  says whether it mirrors. That is deliberate: the decision gets made rather than defaulted.
- **A different test runner.** The suite is Node's built-in `node:test` run through `tsx`, because
  that is what it is on the other side of the mirror too.
- **A credential, a customer id, or a captured response with real identifiers.** There is a guard,
  but please do not make it work for a living.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`) - not enforced by a
hook, but the history is read by people and by the sync, and one line that says what changed is
worth more than the diff.

## Licensing

By contributing you agree that your contributions are licensed under the [MIT](LICENSE) licence,
which is also what lets an accepted change travel back into Stigg's own tree.
