import { describe, expect, it } from "vitest";
import { p2Listing, p2UpstreamUrl } from "./support/packagist";
import { proxyRequest, stubUpstream } from "./support/upstream";

const SHA = "d7059e4c691d05ea1222b5124bed0f961be46e15";
const GITHUB_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${SHA}`;
const CODELOAD = `https://codeload.github.com/Seldaek/monolog/legacy.zip/${SHA}`;
const GITHUB_TOKEN = "github_pat_test-token";
const ARCHIVE_PATH = `/v1/composer/archive?${new URLSearchParams({
	package: "monolog/monolog",
	url: GITHUB_DIST,
})}`;

type Answer = () => Response;

function firstThen(first: Answer, after: Answer): Answer {
	let answered = false;
	return () => {
		const answer = answered ? after : first;
		answered = true;
		return answer();
	};
}

const zip: Answer = () => new Response("zip");
const status =
	(code: number): Answer =>
	() =>
		new Response("throttled", { status: code });
const redirectTo =
	(location: string): Answer =>
	() =>
		new Response(null, { status: 302, headers: { Location: location } });

function githubServing(codeload: Answer, api?: Answer) {
	return stubUpstream({
		[p2UpstreamUrl("monolog/monolog")]: () =>
			new Response(p2Listing("monolog/monolog", [GITHUB_DIST])),
		[CODELOAD]: codeload,
		...(api === undefined ? {} : { [GITHUB_DIST]: api }),
	});
}

const BITBUCKET_DIST =
	"https://bitbucket.org/yicr/php-simple-json-api-client/get/562476a383c97a54a78e1f7af40c923f72d22dce.zip";

function headersOf(call: { init: RequestInit } | undefined) {
	return Object.fromEntries(new Headers(call?.init.headers).entries());
}

describe("a GitHub archive that codeload throttles", () => {
	it.each([429, 403])(
		"is served through the GitHub API when the token is set and codeload answers %i",
		async (throttle) => {
			const upstream = githubServing(
				firstThen(status(throttle), zip),
				redirectTo(CODELOAD),
			);

			const response = await proxyRequest(upstream, ARCHIVE_PATH, {
				githubToken: GITHUB_TOKEN,
			});

			expect(response.status).toBe(200);
			expect(await response.text()).toBe("zip");
			expect(upstream.calls.map((call) => call.url)).toEqual([
				p2UpstreamUrl("monolog/monolog"),
				CODELOAD,
				GITHUB_DIST,
				CODELOAD,
			]);
		},
	);

	it.each([
		["unset", undefined],
		["empty", ""],
		["only whitespace", " \n\t"],
	])("answers as before when the token is %s", async (_, githubToken) => {
		const upstream = githubServing(status(429), redirectTo(CODELOAD));

		const response = await proxyRequest(upstream, ARCHIVE_PATH, {
			...(githubToken === undefined ? {} : { githubToken }),
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
			upstreamStatus: 429,
		});
		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl("monolog/monolog"),
			CODELOAD,
		]);
	});

	it("sends the token to the GitHub API only, never to codeload", async () => {
		const upstream = githubServing(
			firstThen(status(429), zip),
			redirectTo(CODELOAD),
		);

		await proxyRequest(upstream, ARCHIVE_PATH, { githubToken: GITHUB_TOKEN });

		const [, throttled, api, redirected] = upstream.calls;
		expect(headersOf(api)).toEqual({
			authorization: `Bearer ${GITHUB_TOKEN}`,
			"user-agent": "diffpack-proxy (+https://diffpack.io)",
		});
		expect(headersOf(throttled)).not.toHaveProperty("authorization");
		expect(headersOf(redirected)).not.toHaveProperty("authorization");
	});

	it("retries only once when codeload still throttles after the API redirect", async () => {
		const upstream = githubServing(status(429), redirectTo(CODELOAD));

		const response = await proxyRequest(upstream, ARCHIVE_PATH, {
			githubToken: GITHUB_TOKEN,
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
			upstreamStatus: 429,
		});
		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl("monolog/monolog"),
			CODELOAD,
			GITHUB_DIST,
			CODELOAD,
		]);
	});

	it("cancels the throttled codeload body before retrying", async () => {
		let cancelled = false;
		const throttledStream: Answer = () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
				{ status: 429 },
			);
		const upstream = githubServing(
			firstThen(throttledStream, zip),
			redirectTo(CODELOAD),
		);

		await proxyRequest(upstream, ARCHIVE_PATH, { githubToken: GITHUB_TOKEN });

		expect(cancelled).toBe(true);
	});

	it("answers 502 upstream_failed without a status when the API sends no headers in time", async () => {
		const upstream = stubUpstream({
			[p2UpstreamUrl("monolog/monolog")]: () =>
				new Response(p2Listing("monolog/monolog", [GITHUB_DIST])),
			[CODELOAD]: status(429),
			[GITHUB_DIST]: ({ signal }) =>
				new Promise((_, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason));
				}),
		});

		const response = await proxyRequest(upstream, ARCHIVE_PATH, {
			githubToken: GITHUB_TOKEN,
			upstreamTimeoutMs: 20,
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
		});
	});

	it("answers with the API's failure and never with the token", async () => {
		const upstream = githubServing(status(429), status(401));

		const response = await proxyRequest(upstream, ARCHIVE_PATH, {
			githubToken: GITHUB_TOKEN,
		});

		expect(response.status).toBe(502);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
			upstreamStatus: 401,
		});
		expect(body).not.toContain(GITHUB_TOKEN);
		expect([...response.headers.values()].join(" ")).not.toContain(
			GITHUB_TOKEN,
		);
		expect(upstream.calls).toHaveLength(3);
	});
});

describe("redirects from the GitHub API", () => {
	it.each([
		["another host", "https://evil.example/zip"],
		[
			"plain http",
			`http://codeload.github.com/Seldaek/monolog/legacy.zip/${SHA}`,
		],
	])("to %s are refused without fetching it", async (_, location) => {
		const upstream = githubServing(status(429), redirectTo(location));

		const response = await proxyRequest(upstream, ARCHIVE_PATH, {
			githubToken: GITHUB_TOKEN,
		});

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
			upstreamStatus: 302,
		});
		expect(upstream.calls.map((call) => call.url)).not.toContain(location);
	});

	it("are refused after three, and no hop gets the token", async () => {
		const hop = (n: number) => `${CODELOAD}?hop=${n}`;
		const upstream = stubUpstream({
			[p2UpstreamUrl("monolog/monolog")]: () =>
				new Response(p2Listing("monolog/monolog", [GITHUB_DIST])),
			[CODELOAD]: status(429),
			[GITHUB_DIST]: redirectTo(hop(1)),
			[hop(1)]: redirectTo(hop(2)),
			[hop(2)]: redirectTo(hop(3)),
			[hop(3)]: redirectTo(hop(4)),
			[hop(4)]: zip,
		});

		const response = await proxyRequest(upstream, ARCHIVE_PATH, {
			githubToken: GITHUB_TOKEN,
		});

		expect(response.status).toBe(502);
		const hops = upstream.calls.slice(3);
		expect(hops.map((call) => call.url)).toEqual([hop(1), hop(2), hop(3)]);
		for (const call of hops) {
			expect(headersOf(call)).not.toHaveProperty("authorization");
		}
	});
});

describe("the GitHub API fallback", () => {
	it.each([404, 500, 502])(
		"is not tried when codeload answers %i",
		async (failure) => {
			const upstream = githubServing(status(failure), redirectTo(CODELOAD));

			await proxyRequest(upstream, ARCHIVE_PATH, { githubToken: GITHUB_TOKEN });

			expect(upstream.calls.map((call) => call.url)).toEqual([
				p2UpstreamUrl("monolog/monolog"),
				CODELOAD,
			]);
		},
	);

	it("is not tried when codeload cannot be reached", async () => {
		const upstream = stubUpstream({
			[p2UpstreamUrl("monolog/monolog")]: () =>
				new Response(p2Listing("monolog/monolog", [GITHUB_DIST])),
			[GITHUB_DIST]: redirectTo(CODELOAD),
		});

		await proxyRequest(upstream, ARCHIVE_PATH, { githubToken: GITHUB_TOKEN });

		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl("monolog/monolog"),
			CODELOAD,
		]);
	});

	it("is not tried for a throttled Packagist read", async () => {
		const upstream = stubUpstream({
			[p2UpstreamUrl("monolog/monolog")]: status(429),
		});

		await proxyRequest(upstream, "/v1/composer/p2/monolog/monolog.json", {
			githubToken: GITHUB_TOKEN,
		});

		expect(upstream.calls).toHaveLength(1);
		expect(headersOf(upstream.calls[0])).not.toHaveProperty("authorization");
	});

	it("is not tried for a throttled Bitbucket archive", async () => {
		const name = "yicr/php-simple-json-api-client";
		const upstream = stubUpstream({
			[p2UpstreamUrl(name)]: () =>
				new Response(p2Listing(name, [BITBUCKET_DIST])),
			[BITBUCKET_DIST]: status(429),
		});

		await proxyRequest(
			upstream,
			`/v1/composer/archive?${new URLSearchParams({ package: name, url: BITBUCKET_DIST })}`,
			{ githubToken: GITHUB_TOKEN },
		);

		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl(name),
			BITBUCKET_DIST,
		]);
	});
});
