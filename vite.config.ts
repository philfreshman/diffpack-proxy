import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

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
	fmt: {
		useTabs: true,
		printWidth: 80,
		sortImports: { newlinesBetween: false },
		ignorePatterns: [
			"**/*.md",
			".claude/**",
			"renovate.json",
			".github/workflows/renovate.yml",
		],
	},
	lint: {
		plugins: ["typescript", "unicorn", "oxc", "import", "promise", "vitest"],
		categories: {
			correctness: "error",
			suspicious: "error",
			perf: "error",
		},
		env: {
			builtin: true,
			es2024: true,
			worker: true,
		},
		ignorePatterns: [".claude/**"],
		rules: {
			"no-unmodified-loop-condition": "off",
			"vite-plus/prefer-vite-plus-imports": "error",
		},
		overrides: [
			{
				files: ["test/**"],
				rules: {
					"no-await-in-loop": "off",
					"vitest/expect-expect": [
						"error",
						{
							assertFunctionNames: ["expect", "expect*"],
						},
					],
				},
			},
		],
		options: {
			typeAware: true,
			typeCheck: true,
		},
		jsPlugins: [
			{
				name: "vite-plus",
				specifier: "vite-plus/oxlint-plugin",
			},
		],
	},
});
