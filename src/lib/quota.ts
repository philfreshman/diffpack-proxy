import { errorResponse } from "./errors";
import { isoTimestamp } from "./utc-day";

const MS_PER_SECOND = 1000;

export interface QuotaTicket {
	allowed: boolean;
	used: number;
	budget: number;
	resetsAt: Date;
}

export interface QuotaCounter {
	take(now: Date): Promise<QuotaTicket>;
}

export function quotaExhausted(resetsAt: Date, now: Date): Response {
	const response = errorResponse(
		"quota_exhausted",
		"diffpack's Composer proxy has used today's free allowance. It resets at 00:00 UTC.",
		{ resetsAt: isoTimestamp(resetsAt) },
	);
	response.headers.set("Retry-After", String(secondsBetween(now, resetsAt)));
	return response;
}

function secondsBetween(start: Date, end: Date): number {
	return Math.ceil((end.getTime() - start.getTime()) / MS_PER_SECOND);
}
