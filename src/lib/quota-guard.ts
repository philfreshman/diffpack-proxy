import { type QuotaCounter, type QuotaTicket, quotaExhausted } from "./quota";
import { isoTimestamp, nextUtcMidnight } from "./utc-day";

export function createQuotaGuard(dailyQuota: QuotaCounter) {
	let closedUntil = new Date(0);

	async function tryTakeTicket(now: Date): Promise<QuotaTicket | undefined> {
		try {
			return await dailyQuota.take(now);
		} catch {
			return undefined;
		}
	}

	return {
		async admit(now: Date, answer: () => Promise<Response>): Promise<Response> {
			if (now < closedUntil) {
				return quotaExhausted(closedUntil, now);
			}
			const [ticket, response] = await Promise.all([
				tryTakeTicket(now),
				answer(),
			]);
			if (ticket?.allowed) {
				return response;
			}
			closedUntil = ticket?.resetsAt ?? nextUtcMidnight(now);
			await response.body?.cancel();
			return quotaExhausted(closedUntil, now);
		},

		async status(now: Date): Promise<Response> {
			const ticket = await tryTakeTicket(now);
			if (ticket === undefined) {
				return quotaExhausted(nextUtcMidnight(now), now);
			}
			return statusReport(ticket);
		},
	};
}

function statusReport({ used, budget, resetsAt }: QuotaTicket): Response {
	return Response.json({
		open: used < budget,
		used,
		budget,
		resetsAt: isoTimestamp(resetsAt),
	});
}
