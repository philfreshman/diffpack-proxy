# diffpack-proxy

[![Codebase health](.github/badges/fallow-health.svg)](AGENTS.md)

A Cloudflare Worker that lets [diffpack.io](https://diffpack.io) read Composer packages and
search Go modules in the browser. Packagist's metadata, GitHub's `codeload` archives and
pkg.go.dev's search API send no CORS header, so the browser cannot read them directly. The proxy
fetches them and passes them back with the header added. Every other registry is read without it.

- **Stores nothing of its own** except today's request count. It streams bytes without unpacking
  or logging them and never sees a diff. On a custom domain, Cloudflare's edge cache also keeps
  copies of the public files it passed on.
- **Serves only listed archives**: an archive URL must appear in Packagist's metadata for the
  named package, so the proxy cannot fetch arbitrary GitHub, Bitbucket or gitlab.com archives.
- **Stops before Cloudflare's free daily limit** of 100,000 requests. A Durable Object counts
  requests, and past `DAILY_REQUEST_BUDGET` (90,000) the proxy answers `503 quota_exhausted`
  until 00:00 UTC. `GET /v1/status` shows today's count.

Routes, headers and error codes: [docs/contract.md](docs/contract.md). Deploys, releases, the
budget, the edge cache and rollback: [docs/operations.md](docs/operations.md).

## Run it locally

You need [Bun](https://bun.sh) and Node.js `^22.18.0`, `^24.11.0` or `>=26`.

```bash
bun install
bun run dev                 # http://localhost:8787, try /v1/health
bun run typecheck && bun run lint && bun run format:check
bun run test                # inside workerd, offline
```

Lint, format and test run through [Vite+](https://viteplus.dev), configured in `vite.config.ts`.
[fallow](https://fallow.tools) checks for dead code, duplication and import boundaries in the
pre-commit hook and CI; [AGENTS.md](AGENTS.md) explains the setup.

`main` only takes merges from `development`, and every push to `main` deploys.
