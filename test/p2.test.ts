import { describe, expect, it } from "vitest";
import { proxyRequest, stubUpstream } from "./support/upstream";

const P2_PATH = "/v1/composer/p2/monolog/monolog.json";
const P2_UPSTREAM = "https://repo.packagist.org/p2/monolog/monolog.json";
const P2_BYTES = new TextEncoder().encode(
	'{"packages":{"monolog/monolog":[{"version":"3.12.1","description":"Sends your logs to files, sockets, inboxes \\u00e9"}]},  "minified":"composer/2.0"}\n',
);

describe("GET /v1/composer/p2/{vendor}/{package}.json", () => {
	it("passes the Packagist file through byte for byte", async () => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: () =>
				new Response(P2_BYTES, { headers: { "Content-Type": "text/plain" } }),
		});

		const response = await proxyRequest(upstream, P2_PATH);

		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(P2_BYTES);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
		expect(upstream.calls.map((call) => call.url)).toEqual([P2_UPSTREAM]);
	});

	it("answers 404 not_found when Packagist does not know the package", async () => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: () => new Response("Not Found", { status: 404 }),
		});

		const response = await proxyRequest(upstream, P2_PATH);

		expect(response.status).toBe(404);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe("not_found");
		expect(await response.json()).toEqual({
			error: "not_found",
			message: expect.any(String),
		});
	});

	it.each([429, 500, 503])(
		"answers 502 upstream_failed when Packagist answers %i",
		async (status) => {
			const upstream = stubUpstream({
				[P2_UPSTREAM]: () => new Response("busy", { status }),
			});

			const response = await proxyRequest(upstream, P2_PATH);

			expect(response.status).toBe(502);
			expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
				"upstream_failed",
			);
			expect(await response.json()).toEqual({
				error: "upstream_failed",
				message: expect.any(String),
				upstreamStatus: status,
			});
		},
	);

	it("answers 502 upstream_failed without a status when Packagist is unreachable", async () => {
		const response = await proxyRequest(stubUpstream(), P2_PATH);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
		});
	});

	it.each([
		["uppercase", "Monolog/monolog"],
		["three segments", "monolog/monolog/extra"],
		["an empty vendor", "/monolog"],
		["an empty package", "monolog/"],
		["a dot-dot segment", "monolog/.."],
		["a dev-branch file", "monolog/monolog~dev"],
	])("refuses a name with %s as 400 invalid_request", async (_, name) => {
		const upstream = stubUpstream();

		const response = await proxyRequest(
			upstream,
			`/v1/composer/p2/${name}.json`,
		);

		expect(response.status).toBe(400);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"invalid_request",
		);
		expect(upstream.calls).toEqual([]);
	});

	it.each([
		["vendor", `${"a".repeat(30)}!/monolog`],
		["package", `monolog/${"a".repeat(30)}!`],
	])("refuses a long almost-valid %s name without stalling", async (_, name) => {
		const startedAt = performance.now();

		const response = await proxyRequest(
			stubUpstream(),
			`/v1/composer/p2/${name}.json`,
		);

		expect(response.status).toBe(400);
		expect(performance.now() - startedAt).toBeLessThan(100);
	});
});
