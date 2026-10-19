export type Clock = () => number;

interface MemoOptions<Value> {
	lifetimeMs: number;
	capacity: number;
	sizeOf(key: string, value: Value): number;
	now: Clock;
}

interface Remembered<Value> {
	value: Value;
	size: number;
	expiresAt: number;
}

export function createMemo<Value>({
	lifetimeMs,
	capacity,
	sizeOf,
	now,
}: MemoOptions<Value>) {
	const entries = new Map<string, Remembered<Value>>();
	let totalSize = 0;

	function forget(key: string): void {
		const entry = entries.get(key);
		if (entry !== undefined) {
			entries.delete(key);
			totalSize -= entry.size;
		}
	}

	function forgetOldest(): void {
		const oldest = entries.keys().next();
		if (!oldest.done) {
			forget(oldest.value);
		}
	}

	return {
		get(key: string): Value | undefined {
			const entry = entries.get(key);
			if (entry === undefined) {
				return undefined;
			}
			if (entry.expiresAt <= now()) {
				forget(key);
				return undefined;
			}
			return entry.value;
		},

		set(key: string, value: Value): void {
			forget(key);
			const size = sizeOf(key, value);
			if (size > capacity) {
				return;
			}
			while (totalSize + size > capacity) {
				forgetOldest();
			}
			entries.set(key, { value, size, expiresAt: now() + lifetimeMs });
			totalSize += size;
		},
	};
}
