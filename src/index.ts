import { env } from "cloudflare:workers";
import { createProxy } from "./lib/proxy";

export { DailyQuota } from "./daily-quota";

const DAILY_QUOTA_NAME = "global";
const DAILY_QUOTA_LOCATION: DurableObjectLocationHint = "weur";

function dailyQuota() {
	return env.DAILY_QUOTA.getByName(DAILY_QUOTA_NAME, {
		locationHint: DAILY_QUOTA_LOCATION,
	});
}

export default createProxy({
	fetch: fetch.bind(globalThis),
	dailyQuota: { take: (now) => dailyQuota().take(now) },
});
