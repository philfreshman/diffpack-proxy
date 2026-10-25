# Security candidates

`bunx fallow security` reports **candidates for verification, not vulnerabilities**. It matches
code that does something risky (here: calling `fetch` with a URL that is not a fixed string)
against a catalogue of known weakness types (CWE numbers) and asks a human whether
attacker-controlled input can reach it. It is opt-in: its findings never appear under bare
`fallow` or in the `audit` gate, so nothing on this page has ever blocked a commit.

A backlog nobody gates on is a backlog nobody rereads, so the arrangement here is:

- **The one candidate standing on `development` is triaged below, once, with the evidence.**
- **CI fails a pull request that makes a *new* one reachable** (`fallow security --gate
  newly-reachable`, in the `fallow audit (PR gate)` job). fallow has deliberately no mode that
  gates on the whole backlog.

`newly-reachable` asks whether a candidate can be reached from an entry point (here,
`src/index.ts`) in the pull request when the matching candidate could not be reached on the base
branch. A new risky call does; an existing one that fallow merely ranks differently after an edit
nearby does not. The stricter-looking `--gate new` fires on any candidate on a changed line, so in
the app repo it failed the very pull request that added the test proving a candidate safe.

This page is the record of what was decided, and the gate is what keeps it complete. **When a PR
fails the security gate, either fix the sink or add a row here.**

Re-run the review with:

```bash
bunx fallow security
```

## Triage, as of fallow 3.35.0 on 2026-10-25

| # | Site | Category | Verdict |
| :--- | :--- | :--- | :--- |
| 1 | `src/lib/upstream.ts:41` | SSRF (CWE-918) | **guarded — asserted by test** |

### 1 · Non-literal URL passed to `fetch()` in `fetchOrUndefined`

Server-side request forgery (SSRF) means getting a server to fetch a URL the attacker picked. For
this proxy that would mean asking diffpack-proxy for something other than a Packagist file, a
listed Composer archive or a pkg.go.dev search. `fetchOrUndefined` in `src/lib/upstream.ts` is the
only place in the Worker that calls `fetch`, so every upstream request passes through this one line.
fallow rates it `low`, reachable from the entry point with a blast radius of 20, and finds no path
from an untrusted source to it (`reachable_from_untrusted_source: false`).

The question is whether anything in a browser's request can choose the destination **host**. It
cannot, for two separate reasons: how each route builds the first URL, and what the upstream layer
allows a redirect to do.

**The first request.** Every route builds its URL on a fixed `https://` host, and validates the
browser's input before it gets there:

| Route | URL built | What the browser controls, and how it is checked |
| :--- | :--- | :--- |
| `/v1/composer/p2/{name}.json` (`p2.ts`) | `https://repo.packagist.org/p2/${name}.json` | `name` must match Composer's `vendor/package` pattern (`package-name.ts`): lower-case letters, digits, `.`, `_`, `-` and one slash. No `:`, `@`, `%`, `?` or `#`, so it stays a path. |
| `/v1/composer/archive` (`archive.ts`) | `https://codeload.github.com/${owner}/${repo}/legacy.zip/${sha}`, or the listed Bitbucket or gitlab.com URL itself | `url` must match one of three patterns anchored with `^…$` to `https://api.github.com/repos/…`, `https://bitbucket.org/…` or `https://gitlab.com/api/v4/projects/…`, with a fixed shape for every segment. Segments that decode to `.` or `..` are refused. `package` must be a Composer name, and the `url` must then appear in that package's Packagist metadata (`listing.ts`), or the answer is `403 archive_not_listed` without fetching the archive. |
| `/v1/go/search` (`go-search.ts`) | `https://pkg.go.dev/v1/search?q=…&limit=25` | `q`, given once and 1 to 100 characters, goes in through `URLSearchParams`, so it is encoded and cannot add a parameter or leave the query. |

When codeload throttles a GitHub archive and a token is configured, the proxy retries through the
listed `https://api.github.com/repos/…/zipball/…` URL, which already passed the anchored pattern and
the listing check above.

**Redirects.** The proxy never lets `fetch` follow a redirect on its own (`redirect: "manual"`).
`allowedRedirectTarget` follows a `Location` only when the target is `https:`, has no user name,
password or port, and its host is in an allowlist: `COMPOSER_HOSTS` (`repo.packagist.org`,
`codeload.github.com`, `bitbucket.org`, `gitlab.com`) for Composer requests, and `GO_SEARCH_HOSTS`
(`pkg.go.dev`) for Go search, chosen by the host that answered. A Composer host cannot redirect to
pkg.go.dev, nor the other way round. After three redirects it stops. The GitHub token is sent only
on the first request to `api.github.com`; every redirect hop goes without it.

**Asserted by test**, through the Worker's fetch handler with a recording `stubUpstream`
(`test/support/upstream.ts`), whose stub fetch fails for any URL it was not given:

- `test/archive.test.ts`, *a hostile archive url*: 21 hostile `url` values — `http:`, another
  host, a lookalike (`api.github.com.evil.example`), user info, a port, `:443` spelled out, bad or
  short SHAs, `.` and `..` segments (plain and percent-encoded), encoded slashes, extra query
  parameters, a fragment and a trailing newline — are each refused as `unsupported_archive_host`
  with **no upstream call at all**. *GET /v1/composer/archive* asserts the exact URLs fetched for a
  listed GitHub, Bitbucket and gitlab.com archive.
- `test/archive.test.ts`, *a hostile archive package*, and `test/p2.test.ts` (*refuses a name
  with %s*): bad Composer names (upper case, three segments, empty parts, `..`, `~dev`) are refused
  as `invalid_request` with no upstream call.
- `test/listed-archives.test.ts`: an archive URL not in the package's metadata, listed only under
  another package, or present only inside a longer string is refused as `archive_not_listed`, and
  only the Packagist metadata is fetched.
- `test/upstream.test.ts`, *redirects from upstream servers*: redirects to another host, a
  lookalike host, plain `http`, user info, a port, or the Go search host are refused with only the
  first request made; more than three hops are refused.
- `test/go-search.test.ts`: `chi&limit=1000` reaches pkg.go.dev as one encoded `q` value; a
  redirect off pkg.go.dev, or to a Composer host, is refused without fetching it.
- `test/github-token-fallback.test.ts`, *redirects from the GitHub API*: a redirect to another
  host or to plain `http` is not fetched, and no hop after the first gets the token.

**What the tests do not cover.** The host allowlist is checked on redirects only. The first
request's host is safe because each route puts a fixed host in front of validated input, not
because `fetchOrUndefined` checks it. The tests pin each route's exact upstream URLs and its
refusals, but no single test feeds every route hostile input and checks every recorded host
against the allowlist, and the p2 route is not tested with a name that passes the Composer
pattern yet looks like a host (`evil.example/x`). That name is safe — it becomes the path
`/p2/evil.example/x.json` on `repo.packagist.org` — but the property is argued from the code for
that case, not asserted.

**What would break it** is a new route, or a change to an existing one, that passes browser input
to `relay` or `upstream.fetchSuccess` as a whole URL or as the start of one, such as
`new URL(input, base)`, which lets an absolute input replace the base. That is a change to this
sink's reachability, and the gate is meant to catch it. The local fix, if it is ever wanted, is to
check the first URL against the same allowlist as redirects inside `fetchOrUndefined`.

## Blind spots

The report ends with a note that 391 call sites use patterns fallow could not resolve. 387 of
them are dynamic dispatch (a method called on an object whose type fallow cannot follow), and the
ten files with the most are all tests, led by `test/edge-cache.test.ts` (78). That is expected for
test code and is not a finding. `bunx fallow security --format json` lists them under
`unresolved_callee_diagnostics.top_files`.
