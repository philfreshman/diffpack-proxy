import { type QuotaCounter, quotaExhausted } from "./quota";
import { isoTimestamp } from "./utc-day";

export type QuotaGuard = ReturnType<typeof createQuotaGuard>;

export function createQuotaGuard(dailyQuota: QuotaCounter) {
	let closedUntil = new Date(0);

	return {
		async admit(now: Date, answer: () => Promise<Response>): Promise<Response> {
			if (now < closedUntil) {
				return quotaExhausted(closedUntil, now);
			}
			const [ticket, response] = await Promise.all([
				dailyQuota.take(now),
				answer(),
			]);
			if (ticket.allowed) {
				return response;
			}
			closedUntil = ticket.resetsAt;
			await response.body?.cancel();
			return quotaExhausted(ticket.resetsAt, now);
		},

		async status(now: Date): Promise<Response> {
			const { allowed, used, budget, resetsAt } = await dailyQuota.take(now);
			return Response.json({
				open: allowed,
				used,
				budget,
				resetsAt: isoTimestamp(resetsAt),
			});
		},
	};
}
