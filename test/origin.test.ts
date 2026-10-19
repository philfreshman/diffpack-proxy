import { describe, expect, it } from "vitest";
import { proxyRequest, stubUpstream } from "./support/upstream";

const P2_PATH = "/v1/composer/p2/monolog/monolog.json";
const P2_UPSTREAM = "https://repo.packagist.org/p2/monolog/monolog.json";

function servingP2(status = 200) {
	return stubUpstream({
		[P2_UPSTREAM]: () => new Response("{}", { status }),
	});
}

function expectCorsHeadersFor(response: Response, origin: string) {
	expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
	expect(response.headers.get("Vary")).toBe("Origin");
	expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
		"Retry-After, Diffpack-Proxy-Error",
	);
}

async function expectOriginRefused(response: Response) {
	expect(response.status).toBe(403);
	expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
		"origin_not_allowed",
	);
	expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
	expect(await response.json()).toEqual({
		error: "origin_not_allowed",
		message: expect.any(String),
	});
}

describe("an allowed origin", () => {
	it.each([
		"https://diffpack.io",
		"https://www.diffpack.io",
		"http://localhost:4321",
		"http://127.0.0.1:8080",
	])("gets the answer with CORS headers for %s", async (origin) => {
		const response = await proxyRequest(servingP2(), P2_PATH, { origin });

		expect(response.status).toBe(200);
		expectCorsHeadersFor(response, origin);
	});

	it("gets CORS headers on error answers too", async () => {
		const response = await proxyRequest(servingP2(404), P2_PATH, {
			origin: "https://diffpack.io",
		});

		expect(response.status).toBe(404);
		expectCorsHeadersFor(response, "https://diffpack.io");
	});
});

describe("a refused origin", () => {
	it.each([
		"https://evil.example",
		"http://diffpack.io",
		"https://diffpack.io.evil.example",
		"https://sub.diffpack.io",
		"http://localhost",
		"https://localhost:4321",
		"http://localhost:4321.evil.example",
		"null",
	])(
		"gets 403 origin_not_allowed without CORS headers for %s",
		async (origin) => {
			const upstream = servingP2();

			const response = await proxyRequest(upstream, P2_PATH, { origin });

			await expectOriginRefused(response);
			expect(upstream.calls).toEqual([]);
		},
	);

	it("is refused on /v1/health too", async () => {
		const response = await proxyRequest(stubUpstream(), "/v1/health", {
			origin: "https://evil.example",
		});

		await expectOriginRefused(response);
	});
});

describe("a missing origin", () => {
	it("is refused on the Composer routes", async () => {
		const upstream = servingP2();

		const response = await proxyRequest(upstream, P2_PATH, { origin: null });

		await expectOriginRefused(response);
		expect(upstream.calls).toEqual([]);
	});

	it("is accepted on /v1/health, for monitoring", async () => {
		const response = await proxyRequest(stubUpstream(), "/v1/health", {
			origin: null,
		});

		expect(response.status).toBe(200);
		expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
	});
});
