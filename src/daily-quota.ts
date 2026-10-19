import { DurableObject } from "cloudflare:workers";
import type { QuotaTicket } from "./lib/quota";
import { nextUtcMidnight, utcDayOf } from "./lib/utc-day";

interface DayCount {
	day: string;
	used: number;
}

const DAY_COUNT_KEY = "dayCount";

export class DailyQuota extends DurableObject {
	take(now: Date): QuotaTicket {
		const used = this.countRequestOn(utcDayOf(now));
		const budget = Number(this.env.DAILY_REQUEST_BUDGET);
		return {
			allowed: used <= budget,
			used,
			budget,
			resetsAt: nextUtcMidnight(now),
		};
	}

	private countRequestOn(day: string): number {
		const stored = this.ctx.storage.kv.get<DayCount>(DAY_COUNT_KEY);
		const used = stored?.day === day ? stored.used + 1 : 1;
		this.ctx.storage.kv.put<DayCount>(DAY_COUNT_KEY, { day, used });
		return used;
	}
}
