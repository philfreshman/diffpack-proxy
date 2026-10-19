import { describe, expect, it } from "vitest";
import { createProxy } from "../src/lib/proxy";
import { p2Listing } from "./support/packagist";
import { freshDailyQuota } from "./support/quota";
import {
	ALLOWED_ORIGIN,
	PROXY,
	proxyRequest,
	stubUpstream,
} from "./support/upstream";

const P2_PATH = "/v1/composer/p2/monolog/monolog.json";
const P2_UPSTREAM = "https://repo.packagist.org/p2/monolog/monolog.json";

function servingP2(init: ResponseInit = {}) {
	return stubUpstream({ [P2_UPSTREAM]: () => new Response("{}", init) });
}

describe("requests to upstream servers", () => {
	it("send only diffpack's User-Agent, never the browser's headers", async () => {
		const upstream = servingP2();

		await proxyRequest(upstream, P2_PATH, {
			headers: {
				Cookie: "session=secret",
				Authorization: "Bearer secret",
				"User-Agent": "Mozilla/5.0",
			},
		});

		const [call] = upstream.calls;
		expect([...new Headers(call?.init.headers).entries()]).toEqual([
			["user-agent", "diffpack-proxy (+https://diffpack.io)"],
		]);
	});

	it("follow redirects by hand", async () => {
		const upstream = servingP2();

		await proxyRequest(upstream, P2_PATH);

		expect(upstream.calls[0]?.init.redirect).toBe("manual");
	});

	it("never pass Set-Cookie back to the browser", async () => {
		const upstream = servingP2({ headers: { "Set-Cookie": "tracker=1" } });

		const response = await proxyRequest(upstream, P2_PATH);

		expect(response.headers.has("Set-Cookie")).toBe(false);
	});

	it("pass back none of the upstream's headers", async () => {
		const upstream = servingP2({
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Credentials": "true",
				"Content-Disposition": "attachment",
				"X-GitHub-Request-Id": "abc",
			},
		});

		const response = await proxyRequest(upstream, P2_PATH);

		expect([...response.headers.keys()].sort()).toEqual([
			"access-control-allow-origin",
			"access-control-expose-headers",
			"cache-control",
			"content-type",
			"diffpack-proxy-cache",
			"vary",
		]);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			ALLOWED_ORIGIN,
		);
	});
});

describe("bodies from upstream servers", () => {
	it("are streamed to the browser before the upstream finishes sending", async () => {
		const firstChunk = new TextEncoder().encode('{"packages":');
		const upstream = stubUpstream({
			[P2_UPSTREAM]: () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(firstChunk);
						},
					}),
				),
		});

		const response = await proxyRequest(upstream, P2_PATH);
		const reader = response.body?.getReader();
		const firstRead = await reader?.read();
		await reader?.cancel();

		expect(firstRead?.value).toEqual(firstChunk);
	});
});

function redirectTo(location: string, status = 302) {
	return () => new Response(null, { status, headers: { Location: location } });
}

describe("redirects from upstream servers", () => {
	const hop = (n: number) =>
		`https://repo.packagist.org/p2/monolog/monolog.json?hop=${n}`;

	it.each([301, 302, 303, 307, 308])(
		"are followed to an allowed host after a %i",
		async (status) => {
			const sha = "d7059e4c691d05ea1222b5124bed0f961be46e15";
			const dist = `https://api.github.com/repos/Seldaek/monolog/zipball/${sha}`;
			const oldOwner = `https://codeload.github.com/Seldaek/monolog/legacy.zip/${sha}`;
			const newOwner = `https://codeload.github.com/monolog/monolog/legacy.zip/${sha}`;
			const upstream = stubUpstream({
				[P2_UPSTREAM]: () => new Response(p2Listing("monolog/monolog", [dist])),
				[oldOwner]: redirectTo(newOwner, status),
				[newOwner]: () => new Response("zip"),
			});

			const response = await proxyRequest(
				upstream,
				`/v1/composer/archive?${new URLSearchParams({
					package: "monolog/monolog",
					url: dist,
				})}`,
			);

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("zip");
			expect(upstream.calls.map((call) => call.url)).toEqual([
				P2_UPSTREAM,
				oldOwner,
				newOwner,
			]);
		},
	);

	it("resolve a relative Location against the URL that answered", async () => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: redirectTo("/p2/monolog/renamed.json"),
			"https://repo.packagist.org/p2/monolog/renamed.json": () =>
				new Response("{}"),
		});

		const response = await proxyRequest(upstream, P2_PATH);

		expect(response.status).toBe(200);
	});

	it("are followed up to three times", async () => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: redirectTo(hop(1)),
			[hop(1)]: redirectTo(hop(2)),
			[hop(2)]: redirectTo(hop(3)),
			[hop(3)]: () => new Response("{}"),
		});

		const response = await proxyRequest(upstream, P2_PATH);

		expect(response.status).toBe(200);
	});

	it("are refused after three", async () => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: redirectTo(hop(1)),
			[hop(1)]: redirectTo(hop(2)),
			[hop(2)]: redirectTo(hop(3)),
			[hop(3)]: redirectTo(hop(4)),
			[hop(4)]: () => new Response("{}"),
		});

		const response = await proxyRequest(upstream, P2_PATH);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
			upstreamStatus: 302,
		});
		expect(upstream.calls).toHaveLength(4);
	});

	it.each([
		["another host", "https://evil.example/monolog.json"],
		["a lookalike host", "https://repo.packagist.org.evil.example/x.json"],
		["plain http", "http://repo.packagist.org/p2/monolog/monolog.json"],
		["user info", "https://x@repo.packagist.org/p2/monolog/monolog.json"],
		["a port", "https://repo.packagist.org:8443/p2/monolog/monolog.json"],
		["the Go search host", "https://pkg.go.dev/v1/search?q=monolog&limit=25"],
	])("to %s are refused", async (_, location) => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: redirectTo(location),
			[location]: () => new Response("{}"),
		});

		const response = await proxyRequest(upstream, P2_PATH);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
			upstreamStatus: 302,
		});
		expect(upstream.calls).toHaveLength(1);
	});

	it("without a Location are refused", async () => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: () => new Response(null, { status: 302 }),
		});

		const response = await proxyRequest(upstream, P2_PATH);

		expect(response.status).toBe(502);
	});
});

describe("a slow upstream server", () => {
	const TIMEOUT_MS = 20;

	function proxyWithTimeout(upstream: ReturnType<typeof stubUpstream>) {
		return createProxy({
			fetch: upstream.fetch,
			dailyQuota: freshDailyQuota(),
			upstreamTimeoutMs: TIMEOUT_MS,
		});
	}

	function p2Request(): Request {
		return new Request(`${PROXY}${P2_PATH}`, {
			headers: { Origin: ALLOWED_ORIGIN },
		});
	}

	it("is given up on with 502 upstream_failed when it sends no headers in time", async () => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: ({ signal }) =>
				new Promise((_, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason));
				}),
		});

		const response = await proxyWithTimeout(upstream).fetch(p2Request());

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
		});
	});

	it("may take longer than the timeout to send the body once headers arrived", async () => {
		const upstream = stubUpstream({
			[P2_UPSTREAM]: ({ signal }) =>
				new Response(
					new ReadableStream({
						async pull(controller) {
							await scheduler.wait(TIMEOUT_MS * 3);
							if (signal?.aborted) {
								controller.error(signal.reason);
								return;
							}
							controller.enqueue(new TextEncoder().encode("{}"));
							controller.close();
						},
					}),
				),
		});

		const response = await proxyWithTimeout(upstream).fetch(p2Request());

		expect(await response.text()).toBe("{}");
	});
});
