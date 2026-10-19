# Operations

## The daily quota counter

- The count lives in one Durable Object of the class `DailyQuota`, reached by the name `global`,
  so it is exact across all of Cloudflare's locations. It uses SQLite storage, the only kind the
  free plan allows, and stores one row: the UTC day and its count.
- It is created with the location hint `weur` (western Europe), near most of diffpack's readers.
  The hint only matters when the object is first created; Cloudflare keeps it where it started.
  Each counted request makes one round trip to it, a few ms nearby and up to a couple of hundred
  ms from another continent. The proxy runs it alongside the upstream fetch, so it only adds
  delay when it takes longer than the upstream server's first answer.
- One counter call per counted request stays inside the Durable Object free plan: at most
  90,000 of its 100,000 requests and 100,000 row writes a day, and under its 13,000 GB-s a day
  even if it never sleeps (about 10,800 GB-s). Once a Worker isolate (one running copy of the
  Worker in one location) has seen the day used up, it stops calling the counter until 00:00 UTC.
- If the counter cannot be reached, for example because its own daily limit is gone, the proxy
  fails closed: it answers `503 quota_exhausted` until the next 00:00 UTC, when Cloudflare's
  free-plan limits all reset together.
