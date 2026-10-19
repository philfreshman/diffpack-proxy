import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const PROXY = "https://proxy.test";

function get(path: string): Promise<Response> {
	return exports.default.fetch(`${PROXY}${path}`);
}

describe("GET /v1/health", () => {
	it("answers 200 with ok true", async () => {
		const response = await get("/v1/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});
});
