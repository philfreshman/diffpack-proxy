# Proxy HTTP contract, v1

This file is the source of truth for the proxy's HTTP interface. The app (`VITE_DIFFPACK_PROXY_ORIGIN`)
and the wasm engine (`set_proxy_origin`) are its clients, so changing a route, a header or an error
code is a breaking change for both.

`PROXY_ORIGIN` is the proxy's address, for example `https://diffpack-proxy.<account>.workers.dev`.
Only `GET`, `HEAD` and `OPTIONS` are accepted. `HEAD` answers with the same status and headers as
`GET`, without a body.

## Routes

| Route | Upstream | Success |
| :- | :- | :- |
| `GET /v1/composer/p2/{vendor}/{package}.json` | `https://repo.packagist.org/p2/{vendor}/{package}.json` | `200`, body passed through unchanged, `Content-Type: application/json`, `Cache-Control: public, max-age=300` |
| `GET /v1/composer/archive?package={vendor}/{package}&url={dist URL, URL-encoded}` | See the archive table | `200`, streamed, `Content-Type: application/zip`, `Cache-Control: public, max-age=31536000, immutable` |
| `GET /v1/go/search?q={query}` | `https://pkg.go.dev/v1/search?q={query, URL-encoded}&limit=25` | `200`, body passed through unchanged, `Content-Type: application/json`, `Cache-Control: public, max-age=3600` |
| `GET /v1/status` | none | `200 {"open": true, "used": 1234, "budget": 90000, "resetsAt": "2026-10-20T00:00:00Z"}`. See "Daily quota". |
| `GET /v1/health` | none | `200 {"ok": true}`. Skips the quota counter, so keep monitoring infrequent: Cloudflare still counts it. |

`{vendor}/{package}` must match Composer's name rule,
`^[a-z0-9]([_.-]?[a-z0-9]+)*/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$`.

`q` is the search text for Go modules, given exactly once and 1–100 characters long. The proxy
always asks pkg.go.dev for 25 results and adds no other parameter. pkg.go.dev returns packages,
not modules, so several results can share one `modulePath`; the client groups them. When nothing
matches, pkg.go.dev answers `{"items": null, "total": 0}`, which is passed through as it is.
Redirects are followed by hand, at most 3, and only to `https` URLs on `pkg.go.dev`.

`url` is the dist URL exactly as Packagist lists it. It must match one row below, or the answer
is `400 unsupported_archive_host`:

| Packagist lists | The proxy fetches |
| :- | :- |
| `https://api.github.com/repos/{owner}/{repo}/zipball/{sha}` | `https://codeload.github.com/{owner}/{repo}/legacy.zip/{sha}` |
| `https://bitbucket.org/{owner}/{repo}/get/{ref}.zip` | the same URL |
| `https://gitlab.com/api/v4/projects/{project}/repository/archive.zip?sha={sha}` | the same URL |

`{owner}` and `{repo}` match `[A-Za-z0-9_.-]+` (and are never `.` or `..`). `{sha}` is 40
hex characters. `{ref}` is 7–40 hex characters. `{project}` is a number or a URL-encoded path
matching `[A-Za-z0-9%._-]+`. Nothing else is accepted: no user info, no port, no extra query
parameters, `https` only. Redirects are followed by hand, at most 3, and only to `https` URLs
without user info or a port on `repo.packagist.org` or a host in the right-hand column.

The proxy serves only archives that Packagist lists for the named package. Before fetching the
archive, it reads `https://repo.packagist.org/p2/{vendor}/{package}.json` and checks that the file
contains `url` as a JSON string, written with plain or escaped (`\/`) slashes. If it does not,
the answer is `403 archive_not_listed`. If that read fails, the archive is not fetched: a `404`
from Packagist answers `404 not_found`, and any other failure answers `502 upstream_failed`.
Each copy of the Worker remembers a p2 file it read for 5 minutes, so the two archives of one
comparison cost one Packagist read. It keeps at most 8 MB of p2 text and drops the oldest file
first. It also remembers each `package` and `url` pair it found listed for 10 minutes, so an
archive Packagist stops listing can stay servable that long. Failed reads are not remembered.

The GitHub rewrite skips `api.github.com`, which only answers with a redirect to `codeload` and
counts against GitHub's 60-requests-per-hour limit for anonymous API calls.

If `codeload` answers `429` or `403` and the proxy has a GitHub token (see `docs/operations.md`),
it retries that archive once through the listed `api.github.com` URL with the token, then follows
the redirect to `codeload` under the same rules, without the token. The retry's answer is the
answer: if it fails too, it is mapped like any other upstream answer. There is no second retry,
and no retry for any other status, host or route. Without the token, a `429` or `403` from
`codeload` answers `502 upstream_failed` as before.

## Edge cache

On a custom domain, the proxy keeps successful p2, archive and Go search answers in Cloudflare's cache of
the data centre that served them, keyed by the upstream URL it fetched. A later request for the
same upstream URL in the same data centre is answered from there with the same body and headers,
without contacting upstream.

- A p2 file is kept for 5 minutes, a Go search answer for an hour and an archive for up to a
  year, as their `Cache-Control` says. Cloudflare may drop any of them earlier.
- An answer is kept only once the client has received all of it, and only if it is 5 MB or
  smaller. One that declares a larger `Content-Length`, or passes 5 MB while streaming, is
  streamed through without being kept. Errors, upstream answers with a status other than
  `200` (such as a partial `206`) and answers to `HEAD` are never kept.
- An answer from the cache goes through every other rule first: the origin check, the archive
  listing check, the search text check and the daily quota. It counts against the budget like any other request.
- A failing cache never fails the request. If the lookup throws, the answer comes from upstream
  exactly as on a miss and says `miss`. If storing a copy fails, the client has already received
  the whole answer and nothing is kept.
- On `*.workers.dev`, where Cloudflare's cache does nothing, the proxy does not use it at all.

Successful p2, archive and Go search answers carry `Diffpack-Proxy-Cache`: `hit` when the answer came from
the cache, `miss` when it came from upstream and may be kept, and `bypass` when it came from
upstream and will not be kept (on `*.workers.dev`, when upstream answered with a status other
than `200`, or when it declares more than 5 MB). An answer
of unknown length says `miss` and is still not kept if it passes 5 MB. The header is for people
checking the proxy with `curl` or the browser's developer tools; it is not in
`Access-Control-Expose-Headers`, and clients must not depend on it.

## Every answer

- The request's `Origin` must be `https://diffpack.io`, `https://www.diffpack.io`,
  `http://localhost:<port>` or `http://127.0.0.1:<port>`. Otherwise the answer is
  `403 origin_not_allowed` with no CORS headers. `/v1/status` and `/v1/health` also answer when
  there is no `Origin` header, for monitoring, and so does a path that matches no route (`404`).
- Allowed requests get `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin` and
  `Access-Control-Expose-Headers: Retry-After, Diffpack-Proxy-Error`.
- `OPTIONS` answers `204` with `Access-Control-Allow-Methods: GET, HEAD` and `Access-Control-Max-Age: 86400`.
- Nothing from the browser request is forwarded upstream (no cookies, no headers). Upstream
  requests send `User-Agent: diffpack-proxy (+https://diffpack.io)`, as Packagist asks. Only the
  GitHub API retry above adds `Authorization: Bearer <token>`, and never to a redirect target.
  No upstream response header is passed back, `Set-Cookie` included. No answer contains the token.

## Daily quota

The proxy counts its own requests per UTC day and stops before Cloudflare's free daily limit,
with an answer the browser can read.

- Every request counts against the day's budget (`DAILY_REQUEST_BUDGET`, 90,000), refused ones
  included, except `/v1/health` and `OPTIONS` preflights.
- The count restarts at 00:00 UTC.
- Once the budget is used up, every counted request answers `503 quota_exhausted` until the next
  00:00 UTC. So does every counted request while the counter itself cannot be reached: the proxy
  fails closed.
- A counted request starts its upstream reads while the counter answers, the archive route's
  Packagist listing check included. When the counter refuses it, nothing from upstream reaches
  the client: the download is cancelled and the answer is `503 quota_exhausted`.
- `/v1/status` counts like any request and always asks the counter, so it reports the live count.
  `open` says whether the next counted request will be answered: it is `false` once `used`
  reaches `budget`, and the answer stays `200` so monitoring can read it. `used` is today's
  count including this request, and it keeps growing past `budget` while requests arrive.
  `resetsAt` is the next 00:00 UTC. Only when the counter cannot be reached does `/v1/status`
  answer `503 quota_exhausted`.

## Errors

Every error has a JSON body `{"error": "<code>", "message": "<one sentence for people>", …}` and
the header `Diffpack-Proxy-Error: <code>`. The header is how clients tell a proxy answer from an
upstream one.

| Status | `error` | When | Extra fields |
| :- | :- | :- | :- |
| 400 | `invalid_request` | package name bad, missing or given more than once; `url` missing, given more than once or not a URL; `q` missing, empty, longer than 100 characters or given more than once | |
| 400 | `unsupported_archive_host` | `url` matches no row of the archive table | `host` |
| 403 | `origin_not_allowed` | see above | |
| 403 | `archive_not_listed` | `url` is not in that package's Packagist metadata | |
| 404 | `not_found` | Packagist, the archive host or pkg.go.dev answered 404, or the path matches no route | |
| 405 | `method_not_allowed` | not GET, HEAD or OPTIONS, on any path; the answer carries `Allow: GET, HEAD, OPTIONS` | |
| 502 | `upstream_failed` | upstream answered 429, 5xx or another status that is not a success or 404, sent no headers within 25 seconds (the GitHub API retry gets its own 25 seconds), could not be reached, or redirected somewhere not allowed or more than 3 times | `upstreamStatus` when there was one |
| 503 | `quota_exhausted` | today's budget is used up, or the quota counter cannot be reached (see "Daily quota") | `resetsAt` (ISO 8601, next 00:00 UTC), plus a `Retry-After` header in seconds |

The `quota_exhausted` message reads: "diffpack's package proxy has used today's free allowance.
It resets at 00:00 UTC."

## When the proxy cannot answer at all

If Cloudflare's own daily limit is reached (100,000 requests), Cloudflare answers with its
"Error 1027" page instead of running the Worker. That page has no CORS header, so in the browser
`fetch` simply fails, exactly like being offline. Clients treat any network failure on a proxy URL
as `proxy_unreachable` and say that the proxy may be over its daily limit.
