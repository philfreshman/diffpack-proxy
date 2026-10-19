import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TEST_DAILY_BUDGET } from "./support/quota";

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

describe("GET /v1/status", () => {
	it("reports the Worker's own counter and the configured budget", async () => {
		const response = await get("/v1/status");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			open: true,
			budget: TEST_DAILY_BUDGET,
		});
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

describe("a method other than GET, HEAD or OPTIONS", () => {
	it.each(["POST", "PUT", "DELETE", "PATCH"])(
		"answers %s /v1/health with 405 method_not_allowed",
		async (method) => {
			const response = await exports.default.fetch(`${PROXY}/v1/health`, {
				method,
			});

			expect(response.status).toBe(405);
			expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
				"method_not_allowed",
			);
			expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
		},
	);
});
