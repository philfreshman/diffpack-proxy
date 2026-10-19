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

describe("an unknown path", () => {
	it("answers 404 with the not_found error body and header", async () => {
		const response = await get("/v1/nope");

		expect(response.status).toBe(404);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe("not_found");
		expect(await response.json()).toEqual({
			error: "not_found",
			message: expect.any(String),
		});
	});
});
