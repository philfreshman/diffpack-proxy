import { describe, expect, it } from "vitest";
import { p2Listing, p2UpstreamUrl } from "./support/packagist";
import { manualClock, proxyFor, stubUpstream } from "./support/upstream";

const MONOLOG = "monolog/monolog";
const NEW_SHA = "d7059e4c691d05ea1222b5124bed0f961be46e15";
const OLD_SHA = "2ff3d4e3df8a5e6e8b4c1d3d4a1e8f4b5c6d7e8f";
const NEW_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${NEW_SHA}`;
const OLD_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${OLD_SHA}`;

function archivePath(name: string, url: string): string {
	return `/v1/composer/archive?${new URLSearchParams({ package: name, url })}`;
}

function servingMonolog() {
	return stubUpstream({
		[p2UpstreamUrl(MONOLOG)]: () =>
			new Response(p2Listing(MONOLOG, [NEW_DIST, OLD_DIST])),
		[`https://codeload.github.com/Seldaek/monolog/legacy.zip/${NEW_SHA}`]: () =>
			new Response("new zip"),
		[`https://codeload.github.com/Seldaek/monolog/legacy.zip/${OLD_SHA}`]: () =>
			new Response("old zip"),
	});
}

function p2FetchesIn(upstream: ReturnType<typeof stubUpstream>): number {
	return upstream.calls.filter((call) => call.url === p2UpstreamUrl(MONOLOG))
		.length;
}

describe("the second archive of one comparison", () => {
	it("is checked without fetching the package's p2 file again", async () => {
		const upstream = servingMonolog();
		const request = proxyFor(upstream);

		const first = await request(archivePath(MONOLOG, NEW_DIST));
		const second = await request(archivePath(MONOLOG, OLD_DIST));

		expect(await first.text()).toBe("new zip");
		expect(await second.text()).toBe("old zip");
		expect(p2FetchesIn(upstream)).toBe(1);
	});
});

describe("a p2 file that Packagist failed to send", () => {
	it("is fetched again by the next archive request", async () => {
		const answers = [
			new Response("busy", { status: 500 }),
			new Response(p2Listing(MONOLOG, [NEW_DIST])),
		];
		const upstream = stubUpstream({
			[p2UpstreamUrl(MONOLOG)]: () => answers.shift() ?? new Response("{}"),
			[`https://codeload.github.com/Seldaek/monolog/legacy.zip/${NEW_SHA}`]:
				() => new Response("new zip"),
		});
		const request = proxyFor(upstream);

		const failed = await request(archivePath(MONOLOG, NEW_DIST));
		const retried = await request(archivePath(MONOLOG, NEW_DIST));

		expect(failed.status).toBe(502);
		expect(await retried.text()).toBe("new zip");
		expect(p2FetchesIn(upstream)).toBe(2);
	});
});

describe("a remembered p2 file", () => {
	it("is still used after 4 minutes", async () => {
		const upstream = servingMonolog();
		const clock = manualClock();
		const request = proxyFor(upstream, clock);

		await request(archivePath(MONOLOG, NEW_DIST));
		clock.advanceMinutes(4);
		await request(archivePath(MONOLOG, OLD_DIST));

		expect(p2FetchesIn(upstream)).toBe(1);
	});

	it("is fetched again after 5 minutes", async () => {
		const upstream = servingMonolog();
		const clock = manualClock();
		const request = proxyFor(upstream, clock);

		await request(archivePath(MONOLOG, NEW_DIST));
		clock.advanceMinutes(5);
		await request(archivePath(MONOLOG, OLD_DIST));

		expect(p2FetchesIn(upstream)).toBe(2);
	});
});

describe("the p2 files remembered at once", () => {
	const PSR_LOG = "psr/log";
	const PSR_LOG_SHA = "f16e1d5863e37f8d8c2a01719f5b34baa2b714d3";
	const PSR_LOG_DIST = `https://api.github.com/repos/php-fig/log/zipball/${PSR_LOG_SHA}`;
	const FIVE_MILLION = 5_000_000;
	const NINE_MILLION = 9_000_000;

	function servingLargeP2Files(monologLength: number) {
		return stubUpstream({
			[p2UpstreamUrl(MONOLOG)]: () =>
				new Response(
					p2Listing(MONOLOG, [NEW_DIST, OLD_DIST]).padEnd(monologLength, " "),
				),
			[p2UpstreamUrl(PSR_LOG)]: () =>
				new Response(
					p2Listing(PSR_LOG, [PSR_LOG_DIST]).padEnd(FIVE_MILLION, " "),
				),
			[`https://codeload.github.com/Seldaek/monolog/legacy.zip/${NEW_SHA}`]:
				() => new Response("new zip"),
			[`https://codeload.github.com/Seldaek/monolog/legacy.zip/${OLD_SHA}`]:
				() => new Response("old zip"),
			[`https://codeload.github.com/php-fig/log/legacy.zip/${PSR_LOG_SHA}`]:
				() => new Response("psr zip"),
		});
	}

	it("drop the oldest once they pass 8 MB of text", async () => {
		const upstream = servingLargeP2Files(FIVE_MILLION);
		const request = proxyFor(upstream);

		await request(archivePath(MONOLOG, NEW_DIST));
		await request(archivePath(PSR_LOG, PSR_LOG_DIST));
		const afterDrop = await request(archivePath(MONOLOG, OLD_DIST));

		expect(await afterDrop.text()).toBe("old zip");
		expect(p2FetchesIn(upstream)).toBe(2);
	});

	it("never include a single file over 8 MB", async () => {
		const upstream = servingLargeP2Files(NINE_MILLION);
		const request = proxyFor(upstream);

		await request(archivePath(MONOLOG, NEW_DIST));
		const second = await request(archivePath(MONOLOG, OLD_DIST));

		expect(await second.text()).toBe("old zip");
		expect(p2FetchesIn(upstream)).toBe(2);
	});
});

describe("an archive found listed", () => {
	it("is served again after 9 minutes without reading the p2 file again", async () => {
		const upstream = servingMonolog();
		const clock = manualClock();
		const request = proxyFor(upstream, clock);

		await request(archivePath(MONOLOG, NEW_DIST));
		clock.advanceMinutes(9);
		const again = await request(archivePath(MONOLOG, NEW_DIST));

		expect(await again.text()).toBe("new zip");
		expect(p2FetchesIn(upstream)).toBe(1);
	});

	it("is checked against a fresh p2 file after 10 minutes", async () => {
		const upstream = servingMonolog();
		const clock = manualClock();
		const request = proxyFor(upstream, clock);

		await request(archivePath(MONOLOG, NEW_DIST));
		clock.advanceMinutes(10);
		await request(archivePath(MONOLOG, NEW_DIST));

		expect(p2FetchesIn(upstream)).toBe(2);
	});
});
