import { errorResponse } from "./errors";
import { isoTimestamp } from "./utc-day";

export interface QuotaTicket {
	allowed: boolean;
	used: number;
	budget: number;
	resetsAt: Date;
}

export interface QuotaCounter {
	take(now: Date): Promise<QuotaTicket>;
}

export function quotaExhausted(resetsAt: Date): Response {
	return errorResponse(
		"quota_exhausted",
		"diffpack's Composer proxy has used today's free allowance. It resets at 00:00 UTC.",
		{ resetsAt: isoTimestamp(resetsAt) },
	);
}
