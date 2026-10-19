export interface QuotaTicket {
	allowed: boolean;
	used: number;
	budget: number;
	resetsAt: Date;
}

export interface QuotaCounter {
	take(now: Date): Promise<QuotaTicket>;
}
