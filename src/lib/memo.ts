export type Clock = () => number;

interface MemoOptions {
	lifetimeMs: number;
	now: Clock;
}

interface Remembered<Value> {
	value: Value;
	expiresAt: number;
}

export function createMemo<Value>({ lifetimeMs, now }: MemoOptions) {
	const entries = new Map<string, Remembered<Value>>();

	return {
		get(key: string): Value | undefined {
			const entry = entries.get(key);
			if (entry === undefined) {
				return undefined;
			}
			if (entry.expiresAt <= now()) {
				entries.delete(key);
				return undefined;
			}
			return entry.value;
		},

		set(key: string, value: Value): void {
			entries.delete(key);
			entries.set(key, { value, expiresAt: now() + lifetimeMs });
		},
	};
}
