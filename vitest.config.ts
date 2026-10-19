import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const TEST_DAILY_REQUEST_BUDGET = 3;
const TEST_GITHUB_TOKEN = "github_pat_binding-test-token";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					DAILY_REQUEST_BUDGET: TEST_DAILY_REQUEST_BUDGET,
					GITHUB_TOKEN: TEST_GITHUB_TOKEN,
				},
			},
		}),
	],
});
