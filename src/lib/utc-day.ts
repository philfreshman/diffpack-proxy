const ISO_DATE_LENGTH = "YYYY-MM-DD".length;

export function utcDayOf(moment: Date): string {
	return moment.toISOString().slice(0, ISO_DATE_LENGTH);
}

export function nextUtcMidnight(moment: Date): Date {
	return new Date(
		Date.UTC(
			moment.getUTCFullYear(),
			moment.getUTCMonth(),
			moment.getUTCDate() + 1,
		),
	);
}

export function isoTimestamp(moment: Date): string {
	return moment.toISOString().replace(".000Z", "Z");
}
