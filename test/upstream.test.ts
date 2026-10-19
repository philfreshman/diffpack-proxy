import { describe, expect, it } from "vitest";
import { proxyRequest, stubUpstream } from "./support/upstream";

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
});
