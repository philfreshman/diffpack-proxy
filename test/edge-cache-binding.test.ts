import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { p2Listing, p2UpstreamUrl } from "./support/packagist";

const SHA = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c";
const GITHUB_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${SHA}`;
const CODELOAD = `https://codeload.github.com/Seldaek/monolog/legacy.zip/${SHA}`;
const ARCHIVE_URL = `https://proxy.test/v1/composer/archive?${new URLSearchParams(
	{ package: "monolog/monolog", url: GITHUB_DIST },
)}`;

function servingMonologZip() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		if (String(input) === p2UpstreamUrl("monolog/monolog")) {
			return new Response(p2Listing("monolog/monolog", [GITHUB_DIST]));
		}
		return new Response("zip");
	});
}

async function getArchive(): Promise<Response> {
	const response = await exports.default.fetch(ARCHIVE_URL, {
		headers: { Origin: "https://diffpack.io" },
	});
	await response.arrayBuffer();
	return response;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the deployed Worker on a custom domain", () => {
	it("keeps archives in the data centre's default cache", async () => {
		const fetch = servingMonologZip();

		await getArchive();
		await vi.waitFor(async () => {
			expect(await caches.default.match(CODELOAD)).toBeDefined();
		});
		const second = await getArchive();

		expect(second.headers.get("Diffpack-Proxy-Cache")).toBe("hit");
		const codeloadCalls = fetch.mock.calls.filter(
			([url]) => String(url) === CODELOAD,
		);
		expect(codeloadCalls).toHaveLength(1);
	});
});
