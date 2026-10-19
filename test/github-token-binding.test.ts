import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { p2Listing, p2UpstreamUrl } from "./support/packagist";
import { TEST_GITHUB_TOKEN } from "./support/github";

const SHA = "d7059e4c691d05ea1222b5124bed0f961be46e15";
const GITHUB_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${SHA}`;
const CODELOAD = `https://codeload.github.com/Seldaek/monolog/legacy.zip/${SHA}`;

function authorizationOf(init: RequestInit | undefined): string | null {
	return new Headers(init?.headers).get("Authorization");
}

function githubThrottlingAnonymousDownloads() {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url = String(input);
			if (url === p2UpstreamUrl("monolog/monolog")) {
				return new Response(p2Listing("monolog/monolog", [GITHUB_DIST]));
			}
			if (url === GITHUB_DIST && authorizationOf(init) !== null) {
				return new Response(null, {
					status: 302,
					headers: { Location: `${CODELOAD}?authorized` },
				});
			}
			if (url === `${CODELOAD}?authorized`) {
				return new Response("zip");
			}
			return new Response("throttled", { status: 429 });
		});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the deployed Worker with the GITHUB_TOKEN secret", () => {
	it("retries a throttled codeload download with that token", async () => {
		const fetch = githubThrottlingAnonymousDownloads();

		const response = await exports.default.fetch(
			`https://proxy.test/v1/composer/archive?${new URLSearchParams({
				package: "monolog/monolog",
				url: GITHUB_DIST,
			})}`,
			{ headers: { Origin: "https://diffpack.io" } },
		);

		expect(response.status).toBe(200);
		expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("zip");
		const apiCall = fetch.mock.calls.find(([url]) => url === GITHUB_DIST);
		expect(authorizationOf(apiCall?.[1])).toBe(`Bearer ${TEST_GITHUB_TOKEN}`);
	});
});
