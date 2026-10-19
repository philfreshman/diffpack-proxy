import { env } from "cloudflare:workers";

export const TEST_DAILY_BUDGET = Number(env.DAILY_REQUEST_BUDGET);

export function freshDailyQuota() {
	return env.DAILY_QUOTA.get(env.DAILY_QUOTA.newUniqueId());
}
