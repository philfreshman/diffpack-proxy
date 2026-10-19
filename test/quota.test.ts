import { describe, expect, it } from "vitest";
import { createProxy } from "../src/lib/proxy";
import { freshDailyQuota, TEST_DAILY_BUDGET } from "./support/quota";
import { ALLOWED_ORIGIN, PROXY, stubUpstream } from "./support/upstream";

const STATUS_PATH = "/v1/status";

function proxyAt(time: string, dailyQuota = freshDailyQuota()) {
	return createProxy({
		fetch: stubUpstream().fetch,
		dailyQuota,
		clock: () => new Date(time),
	});
}

function get(
	proxy: ReturnType<typeof createProxy>,
	path: string,
): Promise<Response> {
	return proxy.fetch(
		new Request(`${PROXY}${path}`, { headers: { Origin: ALLOWED_ORIGIN } }),
	);
}

describe("GET /v1/status", () => {
	it("reports the open day's count, budget and reset time", async () => {
		const response = await get(proxyAt("2026-10-19T12:00:00Z"), STATUS_PATH);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			open: true,
			used: 1,
			budget: TEST_DAILY_BUDGET,
			resetsAt: "2026-10-20T00:00:00Z",
		});
	});
});
