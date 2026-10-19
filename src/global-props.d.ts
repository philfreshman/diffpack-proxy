declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./index");
		durableNamespaces: "DailyQuota";
	}

	interface Env {
		DAILY_QUOTA: DurableObjectNamespace<import("./daily-quota").DailyQuota>;
		DAILY_REQUEST_BUDGET: number | string;
		GITHUB_TOKEN?: string;
	}
}
