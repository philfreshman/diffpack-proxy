# Operations

## Production origin

`https://diffpack-proxy.philipswiezak.workers.dev`, first deployed on 2026-10-19. This is the
proxy origin the engine and the app are configured with once they add Composer support. The D2 row
of the PHP plan (`php-implementation-plan.md`, in the folder that holds the diffpack repos)
records it too. If the address ever changes, update both places and each client's configured
proxy origin.

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

Deploys never overlap: a second push waits until the running deploy has finished. If more pushes
arrive while one waits, GitHub cancels the waiting run and keeps only the newest, which contains
the others' changes. A run started by hand on another branch only runs the checks, and it never
replaces a waiting deploy of `main`.

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
scripts/smoke.sh https://diffpack-proxy.philipswiezak.workers.dev
scripts/smoke.sh http://localhost:8787
```

Each run sends 6 requests to the Worker. Cloudflare counts all 6 against its 100,000 a day, and
5 of them count against `DAILY_REQUEST_BUDGET` (`/v1/health` does not). A deploy adds at least
one more `/v1/health` request while it waits. The smoke test fails on a day the budget is used
up, because `/v1/status` then reports `open: false`.

## Free-plan limits

These are the Cloudflare Workers Free plan limits that matter for the proxy. Every daily limit
resets at 00:00 UTC; none is monthly.

| Limit | Free plan | How the proxy stays inside it |
| :- | :- | :- |
| Worker requests | 100,000 a day, per account | The proxy's own budget stops at `DAILY_REQUEST_BUDGET` (90,000). |
| CPU time | 10 ms per request | The proxy streams bytes and never unpacks them, so time spent waiting on Packagist or GitHub does not count. |
| Subrequests | 50 per request, Cache API calls included | The archive route makes at most 14: the Packagist read, the archive and, with `GITHUB_TOKEN` set, one GitHub API retry, each with up to 3 redirects, plus one cache lookup and one cache write on a custom domain. |
| Durable Object requests | 100,000 a day | One counter call per counted request, see "The daily quota counter". |
| Durable Object duration | 13,000 GB-s a day | About 10,800 GB-s even if the counter never sleeps. |
| Durable Object SQLite rows | 5 million read and 100,000 written a day, 5 GB stored | One row, written once per counted request. |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## What people see when a limit is reached

- **The proxy's budget is used up.** Every counted request answers `503 quota_exhausted` with
  `resetsAt` and `Retry-After`, and `/v1/status` reports `open: false`. The app can read this
  answer and show its message, "diffpack's Composer proxy has used today's free allowance. It
  resets at 00:00 UTC." Other registries keep working, since they do not use the proxy. This is the normal way a busy day ends.
- **The counter's own Durable Object limits are used up, or it cannot be reached.** The proxy
  fails closed with the same `503 quota_exhausted` answer.
- **Cloudflare's 100,000 Worker requests are used up.** Cloudflare stops running the Worker and
  answers with its own "Error 1027" page. That page has no CORS header, so in the browser the
  request fails like being offline. The app reports `proxy_unreachable` and says the proxy may be
  over its daily limit. This only happens if the requests that arrive after the budget is spent,
  plus the uncounted `/v1/health` checks and `OPTIONS` preflights, add up to more than the 10,000
  of headroom, or if another Worker in the same account uses the account's requests.
- **One address sends too many requests, once the per-IP rate rule exists.** Cloudflare blocks it
  for 10 seconds with its own answer, before the Worker runs (see "Per-IP rate rule"). That
  answer has no CORS header either, so the app reports `proxy_unreachable` for those seconds.
- **A request goes over 10 ms of CPU.** Cloudflare ends it with its own error page, which the
  browser also sees as a network failure. The proxy's work per request is far below this.

## Changing the daily budget

Edit `vars.DAILY_REQUEST_BUDGET` in `wrangler.jsonc`, open a pull request and merge it into
`main`; the deploy applies it. Keep it below 100,000, and leave headroom for the requests that
keep arriving after the budget is spent. Today's count is not reset: if the new budget is below
today's count, the proxy refuses counted requests until 00:00 UTC.

Do not change the value in the Cloudflare dashboard: the next `wrangler deploy` overwrites it with
the value in `wrangler.jsonc`.

## Reading usage in the dashboard

- **Today's count as the proxy sees it:**
  `curl https://diffpack-proxy.philipswiezak.workers.dev/v1/status`. Each call costs one request
  from the budget.
- **Worker requests, errors and CPU time:** **Workers & Pages > diffpack-proxy > Metrics**. These
  aggregate metrics exist even with Workers Logs off.
- **The account's daily request total against the 100,000 limit:** the **Workers & Pages**
  overview page.
- **The counter's requests, duration and storage:** **Workers & Pages > Durable Objects**, then the
  `DailyQuota` namespace.

## Rolling back

Every deploy creates a new Worker version, and Cloudflare keeps the last 100. To go back to the
version before the current one:

```bash
bunx wrangler login
bunx wrangler rollback --message "<why>"
```

`bunx wrangler deployments list` shows recent deployments, and
`bunx wrangler rollback <VERSION_ID>` goes back to a specific one. In the dashboard, the same is
under **Workers & Pages > diffpack-proxy > Deployments**, in the menu next to a version. A
rollback does not change the Durable Object or its stored count, and Cloudflare refuses it across
a change to the Durable Object classes in `migrations`.

A rollback only changes what runs on Cloudflare. The next push to `main` deploys again, so also
revert the bad change on `main`.

## Logging

Workers Logs are off: `observability.enabled` is `false` in `wrangler.jsonc`, and the proxy
calls no `console` method. So Cloudflare stores no request logs for it. What remains is
Cloudflare's aggregate metrics (request counts, errors, CPU time), which do not list single
requests or their URLs.
This matches the README's promise that the proxy logs nothing.

If debugging ever needs request logs:

- **For a few minutes, without storing anything:** `bunx wrangler tail` streams live requests to
  your terminal while it runs. Nothing is kept afterwards.
- **Stored logs:** set `observability` in `wrangler.jsonc` to
  `{ "enabled": true, "head_sampling_rate": 0.01 }` to keep 1 in 100 requests in Workers Logs
  (3 days on the free plan, 7 days once Cloudflare's new observability pricing starts on
  1 December 2026). A logged request includes its URL, so the package name and version, but no
  archive contents and no bodies. Before merging that change, update the "What it stores"
  paragraph in the README to say so, including the sampling rate and the retention.

## GitHub token (optional)

GitHub may throttle anonymous `codeload` downloads from Cloudflare's addresses. That shows up as
archives answering `502 upstream_failed` with `upstreamStatus` `429` or `403`. Only then is the
optional Worker secret `GITHUB_TOKEN` worth setting. With it, the proxy retries such an archive
once through `https://api.github.com/repos/{owner}/{repo}/zipball/{sha}` with the token, and
follows the redirect to `codeload` without it (see "Routes" in `docs/contract.md`). Authenticated
API calls get 5,000 requests per hour, shared with every other token of the same GitHub account.
A retry is still one Worker request and one count against `DAILY_REQUEST_BUDGET`; it only adds
subrequests.

Without the secret, the proxy behaves exactly as before. The proxy never logs the token and
never puts it in an answer.

To create the token (only the repository owner can do this):

1. On GitHub, open **Settings > Developer settings > Personal access tokens > Fine-grained
   tokens** and select **Generate new token**.
2. Name it, for example `diffpack-proxy`, and pick an expiration. Note the date: the fallback
   stops working silently when the token expires.
3. Under **Repository access**, choose **Public repositories**. Add no permissions: the token can
   then only read public repositories.
4. Generate it and copy it once.

To set it on the deployed Worker:

```bash
bunx wrangler login
bunx wrangler secret put GITHUB_TOKEN
```

Paste the token at the prompt, never on the command line, so it stays out of the shell history.
Setting a secret deploys a new version of the Worker right away. Later `wrangler deploy` runs
keep it, because secrets are not part of `wrangler.jsonc`. To rotate it, run the same command
with a new token. To turn the fallback off, run `bunx wrangler secret delete GITHUB_TOKEN`.

For `bun run dev`, put `GITHUB_TOKEN=<token>` in `.dev.vars`, which git ignores.

## Edge cache

The proxy keeps successful p2 and archive answers in Cloudflare's cache, as described under "Edge
cache" in `docs/contract.md`. It only does so on a custom domain: on `workers.dev`, where it runs
today, Cloudflare's cache does nothing, so the proxy does not use it and every answer says
`Diffpack-Proxy-Cache: bypass`. The code is in place and turns itself on once decision D2 in the
PHP plan moves the proxy to a custom domain such as `proxy.diffpack.io`.

What it buys, and what it does not:

- **It saves upstream load and time, not quota.** An answer from the cache still runs the Worker,
  so it still counts as one of Cloudflare's 100,000 requests a day and one count against
  `DAILY_REQUEST_BUDGET`. It saves the trip to GitHub or Packagist, and with it time and the risk
  of GitHub throttling `codeload`. The Packagist listing check still runs before a cached archive
  is served, from the Worker's in-memory copy when it has one.
- **Expect modest hit rates.** The cache belongs to one data centre and is not shared with
  others, so only readers near each other who compare the same versions share entries. Popular
  packages benefit the most.
- **Archives up to 5 MB only.** While an answer streams to the client, the proxy keeps a copy and
  stores it when the client has received all of it. To bound memory in an isolate (128 MB), it
  keeps no copy of an answer that declares more than 5 MB and drops the copy of one that passes
  5 MB while streaming. That covers well over 90% of Composer archives; larger ones, such as
  `symfony/symfony`, stream through as before. A refused or abandoned request stores nothing.
- **Entries.** They are keyed by the upstream URL (`https://codeload.github.com/…`,
  `https://repo.packagist.org/p2/…`). Archive URLs contain a commit SHA, so their content never
  changes; p2 files expire after 5 minutes. If an entry ever has to go, **Caching > Configuration
  > Purge Everything** on the zone removes all of them; a purge by URL does not work for them.

To check it by hand once the custom domain exists (pending until D2), request the same archive
twice from one machine, then the largest archive once:

```bash
ORIGIN=https://proxy.diffpack.io
ARCHIVE="$ORIGIN/v1/composer/archive?package=monolog/monolog&url=https%3A%2F%2Fapi.github.com%2Frepos%2FSeldaek%2Fmonolog%2Fzipball%2Fd7059e4c691d05ea1222b5124bed0f961be46e15"
curl -s -o /dev/null -D - -H 'Origin: https://diffpack.io' "$ARCHIVE" | grep -i diffpack-proxy-cache
curl -s -o /dev/null -D - -H 'Origin: https://diffpack.io' "$ARCHIVE" | grep -i diffpack-proxy-cache
```

The first prints `miss` and the second `hit`. For `symfony/symfony`, take a current dist URL from
`https://repo.packagist.org/p2/symfony/symfony.json`: its archive is larger than 5 MB, so it should
answer `bypass` and arrive whole. Each request costs one count from the budget.

## Per-IP rate rule

The daily budget is shared by everyone, so one client sending requests in a loop can use it up.
One Cloudflare WAF rate-limiting rule slows such a client down. The free plan includes one rule,
but it only applies to a zone on Cloudflare, so this too waits for decision D2. It is dashboard
configuration, not code. Status: documented, not yet created, hand test pending until the custom
domain exists.

Once the zone is on Cloudflare, open it and go to **Security > WAF > Rate limiting rules >
Create rule**, then set:

| Setting | Value |
| :- | :- |
| Rule name | `diffpack-proxy per-IP limit` |
| If incoming requests match | **URI Path** **starts with** `/v1/`, which is the expression `(starts_with(http.request.uri.path, "/v1/"))` |
| With the same characteristics | **IP** (the only choice on the free plan) |
| When rate exceeds | **60** requests per **10 seconds** |
| Then take action | **Block** |
| For duration | **10 seconds** (the only choice on the free plan) |

Then select **Deploy**.

- **Why these numbers.** One comparison in the app costs about three proxy requests: one p2 read
  and two archives. A person stays far below 60 in 10 seconds, even switching versions quickly.
  The free plan only counts over 10 seconds and only blocks for 10 seconds.
- **What it does not do.** It caps one address at 6 requests a second, so one client needs over
  4 hours instead of minutes to use up 90,000. That buys time to notice in the dashboard; it does
  not stop a client that keeps going or uses many addresses. Many readers behind one address, such
  as an office network, share the limit, which is why it is generous.
- **The rule matches paths only.** The free plan cannot match a host name, so the rule covers
  every proxied host in the zone. diffpack's own pages do not start with `/v1/`. If another
  proxied host in the zone ever does, it is limited too.
- **A blocked request never reaches the Worker**, so it costs no Worker request and no count
  from the budget. Cloudflare answers it with its own `429` page, which has no CORS header, so in
  the browser `fetch` fails like being offline and the app reports `proxy_unreachable` until the
  10 seconds are over. `/v1/health` checks from outside are limited like everything else.

To test it by hand once (pending until D2), send more than 60 requests within 10 seconds from one
machine and look at the status codes:

```bash
for request in $(seq 1 70); do
  curl -s -o /dev/null -w '%{http_code}\n' https://proxy.diffpack.io/v1/health
done | sort | uniq -c
```

Expect about 60 `200` answers and the rest `429`, and a `200` again after 10 seconds. The
`/v1/health` path costs nothing from the budget. The blocks show under **Security > Events**.

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
