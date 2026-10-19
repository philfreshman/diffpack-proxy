import { describe, expect, it } from "vitest";
import { p2Listing, p2UpstreamUrl } from "./support/packagist";
import { freshDailyQuota, TEST_DAILY_BUDGET } from "./support/quota";
import { proxyFor, stubUpstream } from "./support/upstream";

const SHA = "d7059e4c691d05ea1222b5124bed0f961be46e15";
const GITHUB_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${SHA}`;
const CODELOAD = `https://codeload.github.com/Seldaek/monolog/legacy.zip/${SHA}`;
const ARCHIVE_PATH = `/v1/composer/archive?${new URLSearchParams({
	package: "monolog/monolog",
	url: GITHUB_DIST,
})}`;
const P2_PATH = "/v1/composer/p2/monolog/monolog.json";
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);

function freshEdgeCache(): Promise<Cache> {
	return caches.open(`edge-cache-${crypto.randomUUID()}`);
}

const LARGEST_CACHED_ARCHIVE_BYTES = 5 * 1024 * 1024;

function servingMonologZip(
	zip: () => Response = () => new Response(ZIP_BYTES),
) {
	return stubUpstream({
		[p2UpstreamUrl("monolog/monolog")]: () =>
			new Response(p2Listing("monolog/monolog", [GITHUB_DIST])),
		[CODELOAD]: zip,
	});
}

const CHUNKS_IN_DOWNLOAD = 3;

function servingMonologZipUntilCancelled() {
	const download = { cancelled: false };
	let chunksLeft = CHUNKS_IN_DOWNLOAD;
	const upstream = stubUpstream({
		[p2UpstreamUrl("monolog/monolog")]: () =>
			new Response(p2Listing("monolog/monolog", [GITHUB_DIST])),
		[CODELOAD]: () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(ZIP_BYTES);
						chunksLeft -= 1;
						if (chunksLeft === 0) {
							controller.close();
						}
					},
					cancel() {
						download.cancelled = true;
					},
				}),
			),
	});
	return { upstream, download };
}

async function usedUpDailyQuota() {
	const dailyQuota = freshDailyQuota();
	for (let request = 0; request < TEST_DAILY_BUDGET; request++) {
		await dailyQuota.take(new Date());
	}
	return dailyQuota;
}

function codeloadCalls(upstream: ReturnType<typeof stubUpstream>) {
	return upstream.calls.filter((call) => call.url === CODELOAD);
}

function recordingCache(cache: Cache) {
	const calls: string[] = [];
	const recording: Pick<Cache, "match" | "put" | "delete"> = {
		match(...args) {
			calls.push("match");
			return cache.match(...args);
		},
		put(...args) {
			calls.push("put");
			return cache.put(...args);
		},
		delete(...args) {
			calls.push("delete");
			return cache.delete(...args);
		},
	};
	return { calls, cache: recording as Cache };
}

async function downloaded(response: Response): Promise<Uint8Array> {
	return new Uint8Array(await response.arrayBuffer());
}

describe("the edge cache on a custom domain", () => {
	it("serves a second request for the same archive without fetching it again", async () => {
		const upstream = servingMonologZip();
		const get = proxyFor(upstream, { edgeCache: await freshEdgeCache() });

		await downloaded(await get(ARCHIVE_PATH));
		await get.settled();
		const second = await get(ARCHIVE_PATH);

		expect(second.status).toBe(200);
		expect(await downloaded(second)).toEqual(ZIP_BYTES);
		expect(second.headers.get("Content-Type")).toBe("application/zip");
		expect(codeloadCalls(upstream)).toHaveLength(1);
	});
});

describe("a p2 file on a custom domain", () => {
	it("is served from the edge cache with the same headers on the second request", async () => {
		const upstream = stubUpstream({
			[p2UpstreamUrl("monolog/monolog")]: () => new Response('{"packages":{}}'),
		});
		const get = proxyFor(upstream, { edgeCache: await freshEdgeCache() });

		const first = await get(P2_PATH);
		const firstBody = await first.text();
		await get.settled();
		const second = await get(P2_PATH);

		expect(await second.text()).toBe(firstBody);
		expect(second.headers.get("Content-Type")).toBe("application/json");
		expect(second.headers.get("Cache-Control")).toBe("public, max-age=300");
		expect(upstream.calls).toHaveLength(1);
	});
});

describe("a cached archive", () => {
	it("still counts against the daily budget", async () => {
		const edgeCache = await freshEdgeCache();
		const warm = proxyFor(servingMonologZip(), { edgeCache });
		await downloaded(await warm(ARCHIVE_PATH));
		await warm.settled();

		const response = await proxyFor(servingMonologZip(), {
			edgeCache,
			dailyQuota: await usedUpDailyQuota(),
		})(ARCHIVE_PATH);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: "quota_exhausted" });
	});

	it("is still checked against the package's Packagist listing", async () => {
		const edgeCache = await freshEdgeCache();
		const warm = proxyFor(servingMonologZip(), { edgeCache });
		await downloaded(await warm(ARCHIVE_PATH));
		await warm.settled();
		const otherPackage = stubUpstream({
			[p2UpstreamUrl("acme/other")]: () =>
				new Response(p2Listing("acme/other", [])),
		});

		const response = await proxyFor(otherPackage, { edgeCache })(
			`/v1/composer/archive?${new URLSearchParams({
				package: "acme/other",
				url: GITHUB_DIST,
			})}`,
		);

		expect(response.status).toBe(403);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"archive_not_listed",
		);
	});
});

describe("answers the edge cache does not keep", () => {
	it("leaves out upstream errors", async () => {
		let answers = 0;
		const upstream = servingMonologZip(() => {
			answers += 1;
			return answers === 1
				? new Response("busy", { status: 503 })
				: new Response(ZIP_BYTES);
		});
		const get = proxyFor(upstream, { edgeCache: await freshEdgeCache() });

		await (await get(ARCHIVE_PATH)).body?.cancel();
		await get.settled();
		const second = await get(ARCHIVE_PATH);

		expect(second.status).toBe(200);
		expect(second.headers.get("Diffpack-Proxy-Cache")).toBe("miss");
	});

	it("leaves out a successful answer other than 200, such as a partial one", async () => {
		let answers = 0;
		const upstream = servingMonologZip(() => {
			answers += 1;
			return answers === 1
				? new Response(ZIP_BYTES.slice(0, 2), { status: 206 })
				: new Response(ZIP_BYTES);
		});
		const get = proxyFor(upstream, { edgeCache: await freshEdgeCache() });

		const partial = await get(ARCHIVE_PATH);
		await downloaded(partial);
		await get.settled();
		const second = await get(ARCHIVE_PATH);

		expect(partial.headers.get("Diffpack-Proxy-Cache")).toBe("bypass");
		expect(await downloaded(second)).toEqual(ZIP_BYTES);
		expect(codeloadCalls(upstream)).toHaveLength(2);
	});

	it("leaves out a HEAD request's answer and cancels its download", async () => {
		const { upstream, download } = servingMonologZipUntilCancelled();
		const edgeCache = await freshEdgeCache();
		const head = proxyFor(upstream, { edgeCache });

		await head(ARCHIVE_PATH, { method: "HEAD" });
		await head.settled();
		const next = servingMonologZip();
		await downloaded(await proxyFor(next, { edgeCache })(ARCHIVE_PATH));

		expect(download.cancelled).toBe(true);
		expect(codeloadCalls(next)).toHaveLength(1);
	});
});

describe("an empty upstream answer on a custom domain", () => {
	it("is passed through as an empty body", async () => {
		const get = proxyFor(
			servingMonologZip(() => new Response(null)),
			{ edgeCache: await freshEdgeCache() },
		);

		const response = await get(ARCHIVE_PATH);

		expect(response.status).toBe(200);
		expect(await downloaded(response)).toEqual(new Uint8Array());
	});
});

describe("the Diffpack-Proxy-Cache header", () => {
	it("says miss when the answer came from upstream and hit when it came from the cache", async () => {
		const get = proxyFor(servingMonologZip(), {
			edgeCache: await freshEdgeCache(),
		});

		const first = await get(ARCHIVE_PATH);
		await downloaded(first);
		await get.settled();
		const second = await get(ARCHIVE_PATH);

		expect(first.headers.get("Diffpack-Proxy-Cache")).toBe("miss");
		expect(second.headers.get("Diffpack-Proxy-Cache")).toBe("hit");
	});

	it("says bypass for an archive too large to cache", async () => {
		const get = proxyFor(
			servingMonologZip(
				() =>
					new Response(ZIP_BYTES, {
						headers: {
							"Content-Length": String(LARGEST_CACHED_ARCHIVE_BYTES + 1),
						},
					}),
			),
			{ edgeCache: await freshEdgeCache() },
		);

		const response = await get(ARCHIVE_PATH);

		expect(response.headers.get("Diffpack-Proxy-Cache")).toBe("bypass");
	});

	it("says bypass on workers.dev", async () => {
		const get = proxyFor(servingMonologZip(), {
			edgeCache: await freshEdgeCache(),
			proxyOrigin: "https://diffpack-proxy.philipswiezak.workers.dev",
		});

		const response = await get(ARCHIVE_PATH);

		expect(response.headers.get("Diffpack-Proxy-Cache")).toBe("bypass");
	});

	it("is left out of error answers", async () => {
		const get = proxyFor(
			servingMonologZip(() => new Response("gone", { status: 404 })),
			{ edgeCache: await freshEdgeCache() },
		);

		const response = await get(ARCHIVE_PATH);

		expect(response.status).toBe(404);
		expect(response.headers.has("Diffpack-Proxy-Cache")).toBe(false);
	});
});

describe("a large archive on a custom domain", () => {
	it("streams straight through without a copy when it declares more than 5 MB", async () => {
		const upstream = servingMonologZip(
			() =>
				new Response(ZIP_BYTES, {
					headers: {
						"Content-Length": String(LARGEST_CACHED_ARCHIVE_BYTES + 1),
					},
				}),
		);
		const get = proxyFor(upstream, { edgeCache: await freshEdgeCache() });

		await downloaded(await get(ARCHIVE_PATH));
		await get.settled();
		await downloaded(await get(ARCHIVE_PATH));

		expect(codeloadCalls(upstream)).toHaveLength(2);
		expect(get.backgroundTasks).toEqual([]);
	});
});

describe("an answer of unknown length on a custom domain", () => {
	it("drops its copy once it passes 5 MB and still streams all of it", async () => {
		const megabyte = new Uint8Array(1024 * 1024).fill(0x5a);
		const megabytesSent = 6;
		const upstream = servingMonologZip(() => {
			let sent = 0;
			return new Response(
				new ReadableStream({
					pull(controller) {
						controller.enqueue(megabyte);
						sent += 1;
						if (sent === megabytesSent) {
							controller.close();
						}
					},
				}),
			);
		});
		const get = proxyFor(upstream, { edgeCache: await freshEdgeCache() });

		const first = await downloaded(await get(ARCHIVE_PATH));
		await get.settled();
		await downloaded(await get(ARCHIVE_PATH));

		expect(first.byteLength).toBe(megabytesSent * megabyte.byteLength);
		expect(codeloadCalls(upstream)).toHaveLength(2);
	});
});

describe("an archive the counter refuses on a custom domain", () => {
	it("cancels the download and leaves nothing in the edge cache", async () => {
		const { upstream, download } = servingMonologZipUntilCancelled();
		const edgeCache = await freshEdgeCache();
		const refused = proxyFor(upstream, {
			edgeCache,
			dailyQuota: await usedUpDailyQuota(),
		});

		const response = await refused(ARCHIVE_PATH);
		await refused.settled();
		const nextDay = servingMonologZip();
		await downloaded(await proxyFor(nextDay, { edgeCache })(ARCHIVE_PATH));

		expect(response.status).toBe(503);
		expect(download.cancelled).toBe(true);
		expect(codeloadCalls(nextDay)).toHaveLength(1);
	});
});

describe("the edge cache on workers.dev", () => {
	it("is not used, so every request streams straight from upstream", async () => {
		const upstream = servingMonologZip();
		const edgeCache = recordingCache(await freshEdgeCache());
		const get = proxyFor(upstream, {
			edgeCache: edgeCache.cache,
			proxyOrigin: "https://diffpack-proxy.philipswiezak.workers.dev",
		});

		const first = await get(ARCHIVE_PATH);
		expect(await downloaded(first)).toEqual(ZIP_BYTES);
		await get.settled();
		const second = await get(ARCHIVE_PATH);

		expect(await downloaded(second)).toEqual(ZIP_BYTES);
		expect(codeloadCalls(upstream)).toHaveLength(2);
		expect(edgeCache.calls).toEqual([]);
		expect(get.backgroundTasks).toEqual([]);
	});
});
