# CLAUDE.md

This file guides Claude Code (claude.ai/code) when working in this repository.

diffpack-proxy is a Cloudflare Worker in TypeScript that fetches Packagist metadata and Composer
archives for the diffpack app and adds CORS headers. It streams bytes only and stores nothing.
Its HTTP interface is [docs/contract.md](docs/contract.md): the app (`VITE_DIFFPACK_PROXY_ORIGIN`)
and the wasm engine (`set_proxy_origin`) are its clients, so a change to a route, a header or an
error code is a breaking change for both. Change the contract first, then the code.

## Commands

Bun installs packages and runs the scripts. Wrangler and the Vitest plugin need Node 22 or newer.

```bash
bun install                 # also turns on the Husky pre-commit hook
bun run dev                 # wrangler dev on :8787
bun run typecheck           # tsc, strict
bun run lint                # biome lint
bun run format              # biome format, check only (biome format --write . to fix)
bun run test                # Vitest inside workerd, offline
bun run deploy              # wrangler deploy
```

The pre-commit hook runs typecheck, lint, format and test. CI (`.github/workflows/ci.yml`) runs
the same on pull requests to `main` and pushes to `main`, from a frozen lockfile.

## Layout

- `src/index.ts`: the Worker entry point. It only wires real dependencies into factories.
- `src/lib/`: pure modules that take their side effects as parameters, for example
  `createProxy(…)`, so tests can pass stubs.
- `src/lib/upstream.ts`: the only module that calls `fetch`. It applies the contract's upstream
  rules (User-Agent, no forwarded headers, redirects by hand, timeout, error mapping) for every
  route.
- `src/lib/errors.ts`: builds every error answer (the JSON body and the `Diffpack-Proxy-Error`
  header). Reuse it for new error codes.
- `test/`: Vitest tests through `@cloudflare/vitest-plugin`. They call the Worker through the
  runtime (`exports.default.fetch` from `cloudflare:workers`), the same seam a browser hits.
- `wrangler.jsonc`: no `routes`, so the Worker deploys to `workers.dev`. Observability is off.

The Worker runs on Cloudflare's runtime, not on Bun, so `src/` must not use `Bun.*` or Node-only
APIs.

## Code style

- Write self-explaining code in Clean Code style: intention-revealing names, small functions that
  do one thing, named constants and types instead of magic values, and a well-named helper instead
  of a block that needs explaining.
- Add no new comments, doc comments included. If code seems to need one, rename or restructure it
  until it does not. The why behind a change goes in the commit message or the PR description.
- Existing comments: keep them true when you change the code they describe, and delete them once
  the code makes them redundant.
- The one exception is a reason a tool requires, such as the explanation after a `biome-ignore`.
- Write tests first, at the public seam (the Worker's fetch handler), and only enough code to make
  each one pass.

## Git workflow

- This repo works on `main` only: branch from the latest `main` and open pull requests against
  `main`. There is no `development` branch.
- Use short, meaningful branch names (`feat/…`, `fix/…`, `chore/…`).
- Make small, independent commits with Conventional Commits: a short imperative header, a blank
  line, and a brief body explaining why. Write each body paragraph as one line.
- Add no AI attribution to commits or pull requests.
- Never commit Cloudflare account IDs, tokens or other secrets. Local secrets go in `.dev.vars`,
  which git ignores.
