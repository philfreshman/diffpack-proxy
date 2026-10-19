import { describe, expect, it } from "vitest";
import { ALLOWED_ORIGIN, proxyRequest, stubUpstream } from "./support/upstream";

const P2_PATH = "/v1/composer/p2/monolog/monolog.json";
const P2_UPSTREAM = "https://repo.packagist.org/p2/monolog/monolog.json";

describe("OPTIONS", () => {
	it("answers a preflight with 204 and the allowed methods, without asking upstream", async () => {
		const upstream = stubUpstream();

		const response = await proxyRequest(upstream, P2_PATH, {
			method: "OPTIONS",
		});

		expect(response.status).toBe(204);
		expect(response.body).toBeNull();
		expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
			"GET, HEAD",
		);
		expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			ALLOWED_ORIGIN,
		);
		expect(upstream.calls).toEqual([]);
	});

	it("refuses a preflight from another origin", async () => {
		const response = await proxyRequest(stubUpstream(), P2_PATH, {
			method: "OPTIONS",
			origin: "https://evil.example",
		});

		expect(response.status).toBe(403);
		expect(response.headers.has("Access-Control-Allow-Methods")).toBe(false);
	});
});

describe("HEAD", () => {
	it("answers with the same status and headers as GET, but no body", async () => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: () => new Response('{"packages":{}}'),
		});

		const response = await proxyRequest(upstream, P2_PATH, { method: "HEAD" });

		expect(response.status).toBe(200);
		expect(response.body).toBeNull();
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			ALLOWED_ORIGIN,
		);
	});

	it("answers an error without a body", async () => {
		const response = await proxyRequest(stubUpstream(), P2_PATH, {
			method: "HEAD",
		});

		expect(response.status).toBe(502);
		expect(response.body).toBeNull();
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"upstream_failed",
		);
	});
});
