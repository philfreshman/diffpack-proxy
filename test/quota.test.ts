import { describe, expect, it } from "vitest";
import { createProxy } from "../src/lib/proxy";
import type { QuotaCounter } from "../src/lib/quota";
import { freshDailyQuota, TEST_DAILY_BUDGET } from "./support/quota";
import { ALLOWED_ORIGIN, PROXY, stubUpstream } from "./support/upstream";

const STATUS_PATH = "/v1/status";
const P2_PATH = "/v1/composer/p2/monolog/monolog.json";
const P2_UPSTREAM = "https://repo.packagist.org/p2/monolog/monolog.json";
const NOON = "2026-10-19T12:00:00Z";

interface QuotaProxyOptions {
	upstream?: ReturnType<typeof stubUpstream>;
	dailyQuota?: QuotaCounter;
}

function servingP2() {
	return stubUpstream({ [P2_UPSTREAM]: () => new Response("{}") });
}

function countingTakes(dailyQuota: QuotaCounter) {
	const takes: Date[] = [];
	return {
		takes,
		take(now: Date) {
			takes.push(now);
			return dailyQuota.take(now);
		},
	};
}

function settableClock(time: string) {
	let now = new Date(time);
	return {
		read: () => now,
		setTo(later: string) {
			now = new Date(later);
		},
	};
}

function proxyAt(
	time: string | ReturnType<typeof settableClock>,
	{
		upstream = servingP2(),
		dailyQuota = freshDailyQuota(),
	}: QuotaProxyOptions = {},
) {
	const clock = typeof time === "string" ? settableClock(time) : time;
	return createProxy({ fetch: upstream.fetch, dailyQuota, clock: clock.read });
}

function send(
	proxy: ReturnType<typeof createProxy>,
	path: string,
	method = "GET",
): Promise<Response> {
	return proxy.fetch(
		new Request(`${PROXY}${path}`, {
			method,
			headers: { Origin: ALLOWED_ORIGIN },
		}),
	);
}

async function sendBeyondTheBudget(
	proxy: ReturnType<typeof createProxy>,
	path: string,
	method = "GET",
) {
	for (let request = 0; request <= TEST_DAILY_BUDGET; request++) {
		await (await send(proxy, path, method)).body?.cancel();
	}
}

async function useUpTheDay(proxy: ReturnType<typeof createProxy>) {
	for (let request = 0; request < TEST_DAILY_BUDGET; request++) {
		const response = await send(proxy, P2_PATH);
		expect(response.status).toBe(200);
		await response.body?.cancel();
	}
}

describe("the daily quota", () => {
	it("answers requests up to the budget and refuses the one that crosses it", async () => {
		const proxy = proxyAt(NOON);

		await useUpTheDay(proxy);
		const response = await send(proxy, P2_PATH);

		expect(response.status).toBe(503);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"quota_exhausted",
		);
	});

	it.each([
		[
			"an archive",
			`/v1/composer/archive?${new URLSearchParams({
				package: "monolog/monolog",
				url: "https://api.github.com/repos/Seldaek/monolog/zipball/d7059e4c691d05ea1222b5124bed0f961be46e15",
			})}`,
		],
		["an unknown path", "/v1/nope"],
	])("refuses %s once the day is used up", async (_, path) => {
		const proxy = proxyAt(NOON);
		await sendBeyondTheBudget(proxy, STATUS_PATH);

		const response = await send(proxy, path);

		expect(response.status).toBe(503);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"quota_exhausted",
		);
	});

	it("opens again at 00:00 UTC and counts from zero", async () => {
		const clock = settableClock("2026-10-19T23:59:59Z");
		const proxy = proxyAt(clock);
		await sendBeyondTheBudget(proxy, P2_PATH);

		clock.setTo("2026-10-20T00:00:00Z");
		const response = await send(proxy, P2_PATH);
		const status = await send(proxy, STATUS_PATH);

		expect(response.status).toBe(200);
		expect(await status.json()).toEqual({
			open: true,
			used: 2,
			budget: TEST_DAILY_BUDGET,
			resetsAt: "2026-10-21T00:00:00Z",
		});
	});

	it("starts the upstream fetch without waiting for the counter", async () => {
		const counterMayAnswer = Promise.withResolvers<void>();
		const upstreamAsked = Promise.withResolvers<void>();
		const realQuota = freshDailyQuota();
		const proxy = proxyAt(NOON, {
			dailyQuota: {
				async take(now) {
					await counterMayAnswer.promise;
					return realQuota.take(now);
				},
			},
			upstream: stubUpstream({
				[P2_UPSTREAM]: () => {
					upstreamAsked.resolve();
					return new Response("{}");
				},
			}),
		});

		const pending = send(proxy, P2_PATH);
		await upstreamAsked.promise;
		counterMayAnswer.resolve();

		expect((await pending).status).toBe(200);
	});

	it("cancels the upstream download of the request it refuses", async () => {
		let downloadCancelled = false;
		const upstream = stubUpstream({
			[P2_UPSTREAM]: () =>
				new Response(
					new ReadableStream({
						cancel() {
							downloadCancelled = true;
						},
					}),
				),
		});
		const proxy = proxyAt(NOON, { upstream });
		for (let request = 0; request < TEST_DAILY_BUDGET; request++) {
			await send(proxy, STATUS_PATH);
		}

		const response = await send(proxy, P2_PATH);

		expect(response.status).toBe(503);
		expect(upstream.calls).toHaveLength(1);
		expect(downloadCancelled).toBe(true);
	});
});

describe("a proxy that saw the day used up", () => {
	it("refuses further requests without asking the counter again", async () => {
		const dailyQuota = countingTakes(freshDailyQuota());
		const proxy = proxyAt(NOON, { dailyQuota });
		await sendBeyondTheBudget(proxy, P2_PATH);
		const takesSoFar = dailyQuota.takes.length;

		const response = await send(proxy, P2_PATH);

		expect(response.status).toBe(503);
		expect(dailyQuota.takes).toHaveLength(takesSoFar);
	});

	it("does not ask upstream either", async () => {
		const upstream = servingP2();
		const proxy = proxyAt(NOON, { upstream });
		await sendBeyondTheBudget(proxy, P2_PATH);
		const upstreamCallsSoFar = upstream.calls.length;

		await send(proxy, P2_PATH);

		expect(upstream.calls).toHaveLength(upstreamCallsSoFar);
	});
});

describe("a counter that cannot be reached", () => {
	const unreachableQuota: QuotaCounter = {
		take: () => Promise.reject(new Error("Exceeded allowed rows written.")),
	};

	it("fails closed until the next 00:00 UTC", async () => {
		const proxy = proxyAt("2026-10-19T23:00:00Z", {
			dailyQuota: unreachableQuota,
		});

		const response = await send(proxy, P2_PATH);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("3600");
		expect(await response.json()).toMatchObject({
			error: "quota_exhausted",
			resetsAt: "2026-10-20T00:00:00Z",
		});
	});

	it("is not asked again before the next 00:00 UTC", async () => {
		const clock = settableClock("2026-10-19T23:00:00Z");
		const dailyQuota = countingTakes(unreachableQuota);
		const proxy = proxyAt(clock, { dailyQuota });
		await send(proxy, P2_PATH);

		await send(proxy, P2_PATH);
		clock.setTo("2026-10-20T00:00:00Z");
		await send(proxy, P2_PATH);

		expect(dailyQuota.takes).toEqual([
			new Date("2026-10-19T23:00:00Z"),
			new Date("2026-10-20T00:00:00Z"),
		]);
	});
});

describe("the quota_exhausted answer", () => {
	it("says when the quota resets, in the body and in Retry-After", async () => {
		const proxy = proxyAt("2026-10-19T23:59:30Z");

		await useUpTheDay(proxy);
		const response = await send(proxy, P2_PATH);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("30");
		expect(await response.json()).toEqual({
			error: "quota_exhausted",
			message:
				"diffpack's Composer proxy has used today's free allowance. It resets at 00:00 UTC.",
			resetsAt: "2026-10-20T00:00:00Z",
		});
	});

	it("rounds Retry-After up to a whole second", async () => {
		const proxy = proxyAt("2026-10-19T23:59:59.250Z");

		await useUpTheDay(proxy);
		const response = await send(proxy, P2_PATH);

		expect(response.headers.get("Retry-After")).toBe("1");
	});

	it("carries the CORS headers, so the browser can read it", async () => {
		const proxy = proxyAt(NOON);

		await useUpTheDay(proxy);
		const response = await send(proxy, P2_PATH);

		expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
			ALLOWED_ORIGIN,
		);
		expect(response.headers.get("Vary")).toBe("Origin");
		expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
			"Retry-After, Diffpack-Proxy-Error",
		);
	});
});

describe("GET /v1/status", () => {
	it("reports the open day's count, budget and reset time", async () => {
		const response = await send(proxyAt(NOON), STATUS_PATH);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			open: true,
			used: 1,
			budget: TEST_DAILY_BUDGET,
			resetsAt: "2026-10-20T00:00:00Z",
		});
	});

	it("answers 200 with open false and the live count once the day is used up", async () => {
		const proxy = proxyAt(NOON);
		await sendBeyondTheBudget(proxy, P2_PATH);

		const response = await send(proxy, STATUS_PATH);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			open: false,
			used: TEST_DAILY_BUDGET + 2,
			budget: TEST_DAILY_BUDGET,
			resetsAt: "2026-10-20T00:00:00Z",
		});
	});

	it("answers 503 quota_exhausted when the counter cannot be reached", async () => {
		const proxy = proxyAt("2026-10-19T23:00:00Z", {
			dailyQuota: {
				take: () => Promise.reject(new Error("Durable Object reset.")),
			},
		});

		const response = await send(proxy, STATUS_PATH);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("3600");
		expect(await response.json()).toMatchObject({
			error: "quota_exhausted",
			resetsAt: "2026-10-20T00:00:00Z",
		});
	});
});

describe("requests outside the quota", () => {
	it.each([
		["GET /v1/health", "/v1/health", "GET"],
		["POST /v1/health", "/v1/health", "POST"],
		["an OPTIONS preflight", P2_PATH, "OPTIONS"],
	])("include %s", async (_, path, method) => {
		const proxy = proxyAt(NOON);

		await sendBeyondTheBudget(proxy, path, method);
		const status = await send(proxy, STATUS_PATH);

		expect(await status.json()).toMatchObject({ open: true, used: 1 });
	});
});
