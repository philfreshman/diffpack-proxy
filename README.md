# diffpack-proxy

A small Cloudflare Worker that lets [diffpack.io](https://diffpack.io) read PHP (Composer)
packages and search Go modules in the browser.

## Why it exists

diffpack computes diffs in the browser. For Composer packages it needs two things the browser is
not allowed to read from another site: Packagist's version metadata
(`repo.packagist.org/p2/…`) and the package archives (mostly GitHub's `codeload`). Neither sends a
CORS header, the browser rule that says which sites may read a response. The proxy fetches those
files and passes them back with the header added.

Go modules are read directly from `proxy.golang.org`, but searching them by keyword needs
pkg.go.dev's search API, which has no CORS header either. The proxy passes those search answers
through the same way. Every other registry diffpack supports is read directly, without the proxy.

## What it stores

No package contents of its own. It streams bytes through without unpacking or logging them, and
it never sees a diff. The only state it keeps is a count of today's requests, so it can stop
itself before Cloudflare's free daily limit is reached.

Once it runs on a custom domain, Cloudflare's cache in each data centre also keeps copies of the
public files it passed on: Packagist metadata for 5 minutes, Go search answers for an hour, and archives of up to 5 MB, which
never change, until Cloudflare drops them. On `workers.dev`, where it runs today, it caches
nothing. A cached answer still counts against the daily budget, so the cache saves trips to
GitHub and Packagist and makes repeat downloads faster, but it does not stretch the budget. See
"Edge cache" in [docs/operations.md](docs/operations.md).

The routes, headers and error codes are described in [docs/contract.md](docs/contract.md).

## Which archives it serves

Only archives that Packagist lists for the named package, so the proxy cannot be used to fetch
any other GitHub, Bitbucket or gitlab.com archive. Before fetching one, it reads the package's
version metadata from Packagist and checks that the archive's URL is in it. That read is a
subrequest the Worker makes, not a request to the Worker, so it costs nothing from the daily
request budget. Each running copy of the Worker keeps the metadata in memory for 5 minutes, so the
two archives of one comparison need one read.

## The daily budget

Cloudflare's free plan runs a Worker for 100,000 requests a day and resets the count at 00:00 UTC.
The limit is daily, not monthly. Past it, Cloudflare answers with its own "Error 1027" page, which
has no CORS header, so the app cannot read it and cannot tell people what happened.

So the proxy counts its own requests in one Durable Object (a single small database that every
Cloudflare location talks to) and stops a little earlier, at `DAILY_REQUEST_BUDGET` requests,
90,000 by default. After that it answers `503 quota_exhausted` with the reset time, which the app
can show, until 00:00 UTC. The 10,000 left over cover the requests that keep arriving after the
budget is spent, since each of them still runs the Worker. `/v1/health` and `OPTIONS` preflights
are not counted. `GET /v1/status` shows today's count, for example
`curl http://localhost:8787/v1/status`.

To change the budget, edit `vars.DAILY_REQUEST_BUDGET` in `wrangler.jsonc` and deploy. Keep it
below 100,000. To try a small budget locally, pass it to Wrangler:

```bash
bun run dev --var DAILY_REQUEST_BUDGET:3
```

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

## Deploy and operate it

Every push to `main` deploys the Worker to Cloudflare and runs `scripts/smoke.sh` against it.
[docs/operations.md](docs/operations.md) covers the first deploy, the smoke test, the free-plan
limits, what people see when a limit is reached, usage, rollback, logging, the edge cache, the
per-IP rate rule and where the daily counter runs.
