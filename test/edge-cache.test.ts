import { describe, expect, it } from "vitest";
import { p2Listing, p2UpstreamUrl } from "./support/packagist";
import { proxyFor, stubUpstream } from "./support/upstream";

const SHA = "d7059e4c691d05ea1222b5124bed0f961be46e15";
const GITHUB_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${SHA}`;
const CODELOAD = `https://codeload.github.com/Seldaek/monolog/legacy.zip/${SHA}`;
const ARCHIVE_PATH = `/v1/composer/archive?${new URLSearchParams({
	package: "monolog/monolog",
	url: GITHUB_DIST,
})}`;
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);

function freshEdgeCache(): Promise<Cache> {
	return caches.open(`edge-cache-${crypto.randomUUID()}`);
}

function servingMonologZip() {
	return stubUpstream({
		[p2UpstreamUrl("monolog/monolog")]: () =>
			new Response(p2Listing("monolog/monolog", [GITHUB_DIST])),
		[CODELOAD]: () => new Response(ZIP_BYTES),
	});
}

function codeloadCalls(upstream: ReturnType<typeof stubUpstream>) {
	return upstream.calls.filter((call) => call.url === CODELOAD);
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
