# Operations

## Production origin

Not deployed yet. The address will be `https://diffpack-proxy.<subdomain>.workers.dev`, where
`<subdomain>` is the Cloudflare account's `workers.dev` subdomain. After the first deploy, write
the real address here and in the D2 row of the PHP plan (`php-implementation-plan.md`, in the
folder that holds the diffpack repos), so the engine and the app use it as their proxy origin.

## How deploys work

`.github/workflows/deploy.yml` deploys on every push to `main`, including merged pull requests and
Renovate's automerges, and can be started by hand from the Actions tab (it deploys only from
`main`). It runs these steps, and stops at the first one that fails:

1. The CI checks from `ci.yml`: typecheck, lint, format, test and shellcheck.
2. A check that the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set.
   If one is missing, the run fails with an error naming it.
3. `wrangler deploy` through `cloudflare/wrangler-action`.
4. A wait of up to about two minutes for `/v1/health` on the address Wrangler reports, since a
   new `workers.dev` address can take a moment to answer.
5. `scripts/smoke.sh` against that address. The address is also written to the run's summary.

Deploys never overlap: a second push waits until the running deploy has finished.

## First deploy

Only the repository owner can do these steps. Never paste the token anywhere but the GitHub
secret.

1. **Cloudflare account and subdomain.** Create a free Cloudflare account, or pick an existing
   one. In the dashboard, open **Workers & Pages** and choose the account's `workers.dev`
   subdomain if it has none yet. The proxy's address will be
   `https://diffpack-proxy.<subdomain>.workers.dev`.
2. **API token.** Under **My Profile > API Tokens**, select **Create Token** and use the **Edit
   Cloudflare Workers** template. Under **Account Resources**, include only that account. Under
   **Zone Resources**, choose **All zones from an account** and the same account (the proxy has
   no routes, so it never uses them). Create the token and copy it once.
3. **Account ID.** Copy it from the account's **Workers & Pages** overview page, or from
   `bunx wrangler whoami` after `bunx wrangler login`.
4. **GitHub secrets.** In `philfreshman/diffpack-proxy`, open **Settings > Secrets and variables >
   Actions** and add two repository secrets: `CLOUDFLARE_API_TOKEN` (the token) and
   `CLOUDFLARE_ACCOUNT_ID` (the account ID).
5. **Deploy.** Open the failed **Deploy** run in the Actions tab and select **Re-run all jobs**,
   start **Deploy** by hand with **Run workflow** on `main`, or push to `main`.
6. **Check it.** The run's summary shows the address. Run the smoke test from a laptop against it
   (see below), then record the address under "Production origin" above and in the plan.

If the smoke test fails right after the very first deploy only because the new address does not
answer yet, wait a few minutes and re-run the workflow.

## Smoke test

`scripts/smoke.sh <origin>` checks a running proxy from outside, the way a browser would:

- `GET /v1/health` answers `200`.
- `GET /v1/status` answers `200` with `open: true`.
- The p2 route for `monolog/monolog` answers `200` with `Access-Control-Allow-Origin` for
  `Origin: https://diffpack.io`.
- `HEAD` on the archive route for monolog 3.12.1 answers `200` with `application/zip`.
- A foreign `Origin` answers `403 origin_not_allowed`.
- An archive Packagist does not list answers `403 archive_not_listed`.

It prints one `PASS` or `FAIL` line per check and exits non-zero if any check failed. It needs
only `bash` and `curl`. Run it by hand against production or a local `bun run dev`:

```bash
scripts/smoke.sh https://diffpack-proxy.<subdomain>.workers.dev
scripts/smoke.sh http://localhost:8787
```

Each run sends 6 requests to the Worker. Cloudflare counts all 6 against its 100,000 a day, and
5 of them count against `DAILY_REQUEST_BUDGET` (`/v1/health` does not). A deploy adds at least
one more `/v1/health` request while it waits. The smoke test fails on a day the budget is used
up, because `/v1/status` then reports `open: false`.

## The daily quota counter

- The count lives in one Durable Object of the class `DailyQuota`, reached by the name `global`,
  so it is exact across all of Cloudflare's locations. It uses SQLite storage, the only kind the
  free plan allows, and stores one row: the UTC day and its count.
- It is created with the location hint `weur` (western Europe), near most of diffpack's readers.
  The hint only matters when the object is first created; Cloudflare keeps it where it started.
  Each counted request makes one round trip to it, a few ms nearby and up to a couple of hundred
  ms from another continent. The proxy runs it alongside the upstream fetch, so it only adds
  delay when it takes longer than the upstream server's first answer.
- One counter call per counted request stays inside the Durable Object free plan: about 90,000
  of its 100,000 requests and 100,000 row writes a day, and under its 13,000 GB-s a day even if
  it never sleeps (about 10,800 GB-s). Once a Worker isolate (one running copy of the Worker in
  one location) has seen the day used up, it stops calling the counter until 00:00 UTC. So past
  the budget, the counter is only called by `/v1/status` and by isolates that have not yet seen
  the day used up.
- If the counter cannot be reached, for example because its own daily limit is gone, the proxy
  fails closed: it answers `503 quota_exhausted` until the next 00:00 UTC, when Cloudflare's
  free-plan limits all reset together.
