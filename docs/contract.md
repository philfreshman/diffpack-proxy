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
| `GET /v1/status` | none | `200 {"open": true, "used": 1234, "budget": 90000, "resetsAt": "2026-10-20T00:00:00Z"}` |
| `GET /v1/health` | none | `200 {"ok": true}`. Skips the quota counter, so keep monitoring infrequent: Cloudflare still counts it. |

`{vendor}/{package}` must match Composer's name rule,
`^[a-z0-9]([_.-]?[a-z0-9]+)*/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$`.

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
comparison cost one Packagist read. Failed reads are not remembered.

The GitHub rewrite skips `api.github.com`, which only answers with a redirect to `codeload` and
counts against GitHub's 60-requests-per-hour limit for anonymous API calls.

## Every answer

- The request's `Origin` must be `https://diffpack.io`, `https://www.diffpack.io`,
  `http://localhost:<port>` or `http://127.0.0.1:<port>`. Otherwise the answer is
  `403 origin_not_allowed` with no CORS headers. `/v1/status` and `/v1/health` also answer when
  there is no `Origin` header, for monitoring, and so does a path that matches no route (`404`).
- Allowed requests get `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin` and
  `Access-Control-Expose-Headers: Retry-After, Diffpack-Proxy-Error`.
- `OPTIONS` answers `204` with `Access-Control-Allow-Methods: GET, HEAD` and `Access-Control-Max-Age: 86400`.
- Nothing from the browser request is forwarded upstream (no cookies, no headers). Upstream
  requests send `User-Agent: diffpack-proxy (+https://diffpack.io)`, as Packagist asks.
  No upstream response header is passed back, `Set-Cookie` included.

## Errors

Every error has a JSON body `{"error": "<code>", "message": "<one sentence for people>", …}` and
the header `Diffpack-Proxy-Error: <code>`. The header is how clients tell a proxy answer from an
upstream one.

| Status | `error` | When | Extra fields |
| :- | :- | :- | :- |
| 400 | `invalid_request` | package name bad, missing or given more than once; `url` missing, given more than once or not a URL | |
| 400 | `unsupported_archive_host` | `url` matches no row of the archive table | `host` |
| 403 | `origin_not_allowed` | see above | |
| 403 | `archive_not_listed` | `url` is not in that package's Packagist metadata | |
| 404 | `not_found` | Packagist or the archive host answered 404, or the path matches no route | |
| 405 | `method_not_allowed` | not GET, HEAD or OPTIONS, on any path; the answer carries `Allow: GET, HEAD, OPTIONS` | |
| 502 | `upstream_failed` | upstream answered 429, 5xx or another status that is not a success or 404, sent no headers within 25 seconds, could not be reached, or redirected somewhere not allowed or more than 3 times | `upstreamStatus` when there was one |
| 503 | `quota_exhausted` | today's budget is used up | `resetsAt` (ISO 8601, next 00:00 UTC), plus a `Retry-After` header in seconds |

The `quota_exhausted` message reads: "diffpack's Composer proxy has used today's free allowance.
It resets at 00:00 UTC."

## When the proxy cannot answer at all

If Cloudflare's own daily limit is reached (100,000 requests), Cloudflare answers with its
"Error 1027" page instead of running the Worker. That page has no CORS header, so in the browser
`fetch` simply fails, exactly like being offline. Clients treat any network failure on a proxy URL
as `proxy_unreachable` and say that the proxy may be over its daily limit.
