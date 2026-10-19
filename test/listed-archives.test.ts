import { describe, expect, it } from "vitest";
import { p2Listing, p2UpstreamUrl } from "./support/packagist";
import { proxyRequest, stubUpstream } from "./support/upstream";

const MONOLOG = "monolog/monolog";
const LISTED_SHA = "d7059e4c691d05ea1222b5124bed0f961be46e15";
const UNLISTED_SHA = "5eae4a6d5e2ba8a3a8cbbd0c0d1e2d1f0e1b8a4c";
const LISTED_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${LISTED_SHA}`;
const UNLISTED_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${UNLISTED_SHA}`;
const LISTED_CODELOAD = `https://codeload.github.com/Seldaek/monolog/legacy.zip/${LISTED_SHA}`;
const UNLISTED_CODELOAD = `https://codeload.github.com/Seldaek/monolog/legacy.zip/${UNLISTED_SHA}`;

function archivePath(name: string, url: string): string {
	return `/v1/composer/archive?${new URLSearchParams({ package: name, url })}`;
}

function servingMonolog(p2Text = p2Listing(MONOLOG, [LISTED_DIST])) {
	return stubUpstream({
		[p2UpstreamUrl(MONOLOG)]: () => new Response(p2Text),
		[LISTED_CODELOAD]: () => new Response("zip"),
		[UNLISTED_CODELOAD]: () => new Response("zip"),
	});
}

describe("an archive url that the package's Packagist metadata lists", () => {
	it("is served", async () => {
		const upstream = servingMonolog();

		const response = await proxyRequest(
			upstream,
			archivePath(MONOLOG, LISTED_DIST),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("zip");
		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl(MONOLOG),
			LISTED_CODELOAD,
		]);
	});
});

describe("an archive url written with escaped slashes in the Packagist metadata", () => {
	it("is served", async () => {
		const upstream = servingMonolog(
			`{"packages":{"monolog/monolog":[{"version":"3.12.1","dist":{"type":"zip","url":"https:\\/\\/api.github.com\\/repos\\/Seldaek\\/monolog\\/zipball\\/${LISTED_SHA}","shasum":""}}]},"minified":"composer/2.0"}`,
		);

		const response = await proxyRequest(
			upstream,
			archivePath(MONOLOG, LISTED_DIST),
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("zip");
	});
});

describe("an archive url that the package's Packagist metadata does not list", () => {
	it("is refused with 403 archive_not_listed", async () => {
		const upstream = servingMonolog();

		const response = await proxyRequest(
			upstream,
			archivePath(MONOLOG, UNLISTED_DIST),
		);

		expect(response.status).toBe(403);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"archive_not_listed",
		);
		expect(await response.json()).toEqual({
			error: "archive_not_listed",
			message: expect.any(String),
		});
		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl(MONOLOG),
		]);
	});
});

describe("an archive url listed under another package", () => {
	it("is refused with 403 archive_not_listed", async () => {
		const upstream = stubUpstream({
			[p2UpstreamUrl("psr/log")]: () =>
				new Response(
					p2Listing("psr/log", [
						"https://api.github.com/repos/php-fig/log/zipball/f16e1d5863e37f8d8c2a01719f5b34baa2b714d3",
					]),
				),
			[p2UpstreamUrl(MONOLOG)]: () =>
				new Response(p2Listing(MONOLOG, [LISTED_DIST])),
			[LISTED_CODELOAD]: () => new Response("zip"),
		});

		const response = await proxyRequest(
			upstream,
			archivePath("psr/log", LISTED_DIST),
		);

		expect(response.status).toBe(403);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"archive_not_listed",
		);
		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl("psr/log"),
		]);
	});
});

describe("an archive url that the metadata holds only inside a longer string", () => {
	it.each([
		["after other text", `https://mirror.example/${LISTED_DIST}`],
		["before other text", `${LISTED_DIST}/extra`],
	])("%s is refused with 403 archive_not_listed", async (_, longerString) => {
		const upstream = servingMonolog(
			`{"packages":{"monolog/monolog":[{"version":"1.0.0","homepage":"${longerString}"}]},"minified":"composer/2.0"}`,
		);

		const response = await proxyRequest(
			upstream,
			archivePath(MONOLOG, LISTED_DIST),
		);

		expect(response.status).toBe(403);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"archive_not_listed",
		);
	});
});

describe("a Packagist failure during the listing check", () => {
	it("answers 404 not_found when Packagist does not know the package", async () => {
		const upstream = stubUpstream({
			[p2UpstreamUrl(MONOLOG)]: () =>
				new Response("Not Found", { status: 404 }),
			[LISTED_CODELOAD]: () => new Response("zip"),
		});

		const response = await proxyRequest(
			upstream,
			archivePath(MONOLOG, LISTED_DIST),
		);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "not_found",
			message: expect.any(String),
		});
		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl(MONOLOG),
		]);
	});

	it("answers 502 upstream_failed when Packagist answers 500", async () => {
		const upstream = stubUpstream({
			[p2UpstreamUrl(MONOLOG)]: () => new Response("busy", { status: 500 }),
			[LISTED_CODELOAD]: () => new Response("zip"),
		});

		const response = await proxyRequest(
			upstream,
			archivePath(MONOLOG, LISTED_DIST),
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
			upstreamStatus: 500,
		});
		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl(MONOLOG),
		]);
	});

	it("answers 502 upstream_failed when Packagist cannot be reached", async () => {
		const upstream = stubUpstream({
			[LISTED_CODELOAD]: () => new Response("zip"),
		});

		const response = await proxyRequest(
			upstream,
			archivePath(MONOLOG, LISTED_DIST),
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
		});
		expect(upstream.calls.map((call) => call.url)).toEqual([
			p2UpstreamUrl(MONOLOG),
		]);
	});

	it("answers 502 upstream_failed when the Packagist body breaks off", async () => {
		const upstream = stubUpstream({
			[p2UpstreamUrl(MONOLOG)]: () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"packages":'));
							controller.error(new TypeError("Network connection lost."));
						},
					}),
				),
			[LISTED_CODELOAD]: () => new Response("zip"),
		});

		const response = await proxyRequest(
			upstream,
			archivePath(MONOLOG, LISTED_DIST),
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "upstream_failed",
			message: expect.any(String),
		});
	});
});
