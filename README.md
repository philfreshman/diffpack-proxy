# diffpack-proxy

A small Cloudflare Worker that lets [diffpack.io](https://diffpack.io) read PHP (Composer)
packages in the browser.

## Why it exists

diffpack computes diffs in the browser. For Composer packages it needs two things the browser is
not allowed to read from another site: Packagist's version metadata
(`repo.packagist.org/p2/…`) and the package archives (mostly GitHub's `codeload`). Neither sends a
CORS header, the browser rule that says which sites may read a response. The proxy fetches those
files and passes them back with the header added. Every other registry diffpack supports is read
directly, without the proxy.

## What it stores

Nothing. It streams bytes through without unpacking, storing or logging them, and it never sees
a diff. The only state it will keep is a count of today's requests, so it can stop itself before
Cloudflare's free daily limit is reached.

The routes, headers and error codes are described in [docs/contract.md](docs/contract.md).

## Run it locally

You need [Bun](https://bun.sh) and Node.js 22 or newer (Wrangler and the test runner use Node).

```bash
bun install
bun run dev
```

The Worker then answers on `http://localhost:8787`, for example
`curl http://localhost:8787/v1/health` returns `{"ok":true}`.

```bash
bun run typecheck && bun run lint && bun run format
bun run test
```

`bun run test` runs the tests inside `workerd`, Cloudflare's Workers runtime, without network
access.
