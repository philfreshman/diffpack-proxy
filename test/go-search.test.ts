import { describe, expect, it } from "vitest";
import { proxyRequest, stubUpstream } from "./support/upstream";

const SEARCH_UPSTREAM = "https://pkg.go.dev/v1/search?q=chi&limit=25";
const SEARCH_BYTES = new TextEncoder().encode(
	'{"items":[{"packagePath":"github.com/go-chi/chi/v5","modulePath":"github.com/go-chi/chi/v5","version":"v5.5.0","synopsis":"Package chi is a small router \\u00e9"}],"total":1}\n',
);

describe("GET /v1/go/search", () => {
	it("passes the pkg.go.dev answer through byte for byte", async () => {
		const upstream = stubUpstream({
			[SEARCH_UPSTREAM]: () =>
				new Response(SEARCH_BYTES, {
					headers: { "Content-Type": "text/plain" },
				}),
		});

		const response = await proxyRequest(upstream, "/v1/go/search?q=chi");

		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(SEARCH_BYTES);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
		expect(upstream.calls.map((call) => call.url)).toEqual([SEARCH_UPSTREAM]);
	});

	it.each([
		["missing", ""],
		["empty", "?q="],
		["longer than 100 characters", `?q=${"a".repeat(101)}`],
		["given twice", "?q=chi&q=gin"],
	])(
		"refuses search text that is %s as 400 invalid_request",
		async (_, query) => {
			const upstream = stubUpstream();

			const response = await proxyRequest(upstream, `/v1/go/search${query}`);

			expect(response.status).toBe(400);
			expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
				"invalid_request",
			);
			expect(upstream.calls).toEqual([]);
		},
	);

	it("sends the search text as one encoded value, so it cannot add parameters", async () => {
		const smuggled = "chi&limit=1000";
		const upstream = stubUpstream({
			"https://pkg.go.dev/v1/search?q=chi%26limit%3D1000&limit=25": () =>
				new Response('{"items":null,"total":0}'),
		});

		const response = await proxyRequest(
			upstream,
			`/v1/go/search?${new URLSearchParams({ q: smuggled })}`,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ items: null, total: 0 });
	});

	it("accepts search text of exactly 100 characters", async () => {
		const longest = "a".repeat(100);
		const upstream = stubUpstream({
			[`https://pkg.go.dev/v1/search?q=${longest}&limit=25`]: () =>
				new Response('{"items":null,"total":0}'),
		});

		const response = await proxyRequest(upstream, `/v1/go/search?q=${longest}`);

		expect(response.status).toBe(200);
	});

	it("follows a redirect that stays on pkg.go.dev", async () => {
		const moved = "https://pkg.go.dev/v1/search/?q=chi&limit=25";
		const upstream = stubUpstream({
			[SEARCH_UPSTREAM]: () =>
				new Response(null, { status: 302, headers: { Location: moved } }),
			[moved]: () => new Response(SEARCH_BYTES),
		});

		const response = await proxyRequest(upstream, "/v1/go/search?q=chi");

		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(SEARCH_BYTES);
	});

	it("answers 502 upstream_failed when pkg.go.dev redirects elsewhere", async () => {
		const upstream = stubUpstream({
			[SEARCH_UPSTREAM]: () =>
				new Response(null, {
					status: 302,
					headers: { Location: "https://evil.example/search" },
				}),
		});

		const response = await proxyRequest(upstream, "/v1/go/search?q=chi");

		expect(response.status).toBe(502);
		expect(upstream.calls.map((call) => call.url)).toEqual([SEARCH_UPSTREAM]);
	});

	it("answers 502 upstream_failed when pkg.go.dev redirects to a Composer host", async () => {
		const composerHost = "https://repo.packagist.org/p2/go-chi/chi.json";
		const upstream = stubUpstream({
			[SEARCH_UPSTREAM]: () =>
				new Response(null, {
					status: 302,
					headers: { Location: composerHost },
				}),
			[composerHost]: () => new Response("{}"),
		});

		const response = await proxyRequest(upstream, "/v1/go/search?q=chi");

		expect(response.status).toBe(502);
		expect(upstream.calls.map((call) => call.url)).toEqual([SEARCH_UPSTREAM]);
	});

	it.each([
		[404, "not_found"],
		[429, "upstream_failed"],
		[500, "upstream_failed"],
	])("maps a pkg.go.dev %i to %s", async (status, error) => {
		const upstream = stubUpstream({
			[SEARCH_UPSTREAM]: () => new Response("busy", { status }),
		});

		const response = await proxyRequest(upstream, "/v1/go/search?q=chi");

		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(error);
	});
});
