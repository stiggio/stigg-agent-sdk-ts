# Contributing

Thanks for looking. A few conventions here are stricter than usual - worth a minute before you
spend an hour.

## Running it

Node.js 22 or later.

```sh
corepack enable          # Node 25 and later: npm install -g corepack first
yarn install
yarn test
```

[Corepack](https://github.com/nodejs/corepack) pins Yarn to the version in `packageManager`. It
shipped with Node from 14.19 and was unbundled in Node 25, so on newer versions install it first.

`yarn lint`, `yarn format`, `yarn typecheck` and `yarn build` do what they say, and CI runs exactly
those plus `yarn test` - so a green local run is a green pull request.

## How changes land

The SDK is developed and released by Stigg. A pull request here is reviewed and, once accepted,
carried into the release: a fix made here does reach the published package, though not
automatically, so allow for a little lag between the merge and the version on npm.

## What will get a change sent back

- **Reformatting.** `.prettierrc` and `eslint.config.mjs` are shared with the upstream project and
  are not ours to change here - a reformatted package buries whatever the change was actually
  about. If a rule is wrong, open an issue rather than a pull request.
- **A new top-level path nobody classified.** `yarn test:repo` fails until the repository's own
  checks know what it is. That is deliberate: the decision gets made rather than defaulted.
- **A different test runner.** The suite is Node's built-in `node:test` run through `tsx`, and new
  tests belong in `test/` as `*.test.ts`.
- **A credential, a customer id, or a captured response with real identifiers.** There is a guard,
  but please do not make it work for a living.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`) - not enforced by a
hook, but the history is read by people, and one line saying what changed is worth more than the
diff.

## Signing off

Every commit needs a `Signed-off-by` line, which `git commit -s` adds for you:

```
git commit -s -m "fix: stop the retry loop swallowing the first error"
```

That line is the [Developer Certificate of Origin](https://developercertificate.org) - a statement
that you wrote the change, or otherwise have the right to contribute it under this licence. It is
checked on every pull request. There is no separate agreement to sign, and nothing is sent anywhere.

Forgot it on the last commit: `git commit --amend -s --no-edit`. On several, the quickest fix is
`git rebase --signoff main`.

## Licensing

By contributing you agree that your contributions are licensed under the [MIT](LICENSE) licence.
