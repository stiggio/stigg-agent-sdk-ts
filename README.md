# Stigg Agent SDK

Runtime governance for agentic stacks: check entitlements, credits and budgets **before** a model
call, meter what the call actually used **after** it, and let [Stigg](https://stigg.io) handle
pricing, packaging and billing.

This repository is an **open mirror** of the SDK Stigg develops internally. It is here to be read
and to be run - clone it, run the examples against mocks with no API keys and no Stigg account, and
see how the thing actually works.

> **Status:** the source arrives in the first sync from Stigg's internal repository, and this page
> is replaced by the SDK's own README when it does.

## Running it

Node.js 22 or later.

```sh
corepack enable          # Node 25 and later: npm install -g corepack first
yarn install
yarn test
```

[Corepack](https://github.com/nodejs/corepack) is what pins Yarn to the version in
`packageManager`, so everyone resolves the same lockfile. It shipped with Node from 14.19 and was
unbundled in Node 25, which is why newer versions need the extra line.

| Command                             | What it does                                            |
| ----------------------------------- | ------------------------------------------------------- |
| `yarn build`                        | type-checks, then emits `dist/`                         |
| `yarn lint`                         | ESLint, in the configuration the SDK is written against |
| `yarn format` / `yarn format:check` | Prettier over the repository                            |
| `yarn typecheck`                    | `tsc` over the source, tests, examples and tooling      |
| `yarn test`                         | the repository guards, then the SDK's own suite         |

Once the source lands, the examples run one per layer of the agent stack - a client you wrap, a
gateway you call or operate - and each one works offline against a built-in mock of both the LLM
vendor and the Stigg API. The SDK's README covers them in detail.

## What this repository is not

- **It does not publish.** `@stigg/agent-sdk-js` on npm is built and released by Stigg internally;
  the manifest here is `private` and a guard keeps it that way.
- **It is not where the SDK is developed.** Changes are made internally and mirrored here by an
  agent working from [`.sync-manifest.json`](.sync-manifest.json), which is the contract for what
  crosses and how. The return journey is manual for now: a pull request accepted here is reviewed
  and then applied inward by a maintainer, so a fix made here does reach the published package -
  it is just not a button yet.

## Layout

```
src/ test/ testing/ examples/   the SDK - mirrored with the internal repository
docs/instances.md               what exists at runtime - mirrored
tools/repo-tests/               guards that keep the mirror honest, run by `yarn test`
.sync-manifest.json             the mirror contract: what crosses, which way, and how
```

## License

MIT © Stigg Inc. See [LICENSE](LICENSE).
