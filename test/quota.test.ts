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

function proxyAt(
	time: string,
	{
		upstream = servingP2(),
		dailyQuota = freshDailyQuota(),
	}: QuotaProxyOptions = {},
) {
	return createProxy({
		fetch: upstream.fetch,
		dailyQuota,
		clock: () => new Date(time),
	});
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
});

describe("requests outside the quota", () => {
	it.each([
		["GET /v1/health", "/v1/health", "GET"],
		["POST /v1/health", "/v1/health", "POST"],
	])("include %s", async (_, path, method) => {
		const proxy = proxyAt(NOON);

		await sendBeyondTheBudget(proxy, path, method);
		const status = await send(proxy, STATUS_PATH);

		expect(await status.json()).toMatchObject({ open: true, used: 1 });
	});
});
