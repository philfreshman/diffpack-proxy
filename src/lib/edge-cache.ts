import type { Upstream } from "./upstream";

export type Relay = (
	url: string,
	headers: Record<string, string>,
	githubApiUrl?: string,
) => Promise<Response>;

const LARGEST_CACHED_BYTES = 5 * 1024 * 1024;
const CACHEABLE_STATUS = 200;
const CACHE_OUTCOME_HEADER = "Diffpack-Proxy-Cache";

type CacheOutcome = "hit" | "miss" | "bypass";

export type BackgroundWork = Pick<ExecutionContext, "waitUntil">;

interface CopiedStream {
	body: ReadableStream<Uint8Array>;
	copy: Promise<Uint8Array | undefined>;
}

export function bypassingRelay(upstream: Upstream): Relay {
	return async (url, headers, githubApiUrl) => {
		const fetched = await upstream.fetchSuccess(url, githubApiUrl);
		if ("failure" in fetched) {
			return fetched.failure;
		}
		return answer(fetched.answer.body, headers, "bypass");
	};
}

export function cachingRelay(
	upstream: Upstream,
	cache: Cache,
	background: BackgroundWork,
): Relay {
	return async (url, headers, githubApiUrl) => {
		const hit = await ignoringCacheFailure(() => cache.match(url));
		if (hit !== undefined) {
			return answer(hit.body, headers, "hit");
		}
		const fetched = await upstream.fetchSuccess(url, githubApiUrl);
		if ("failure" in fetched) {
			return fetched.failure;
		}
		const source = fetched.answer.body;
		if (source === null || !isCacheable(fetched.answer)) {
			return answer(source, headers, "bypass");
		}
		const { body, copy } = keepingACopy(
			source,
			new BoundedCopy(LARGEST_CACHED_BYTES, declaredLength(fetched.answer)),
		);
		background.waitUntil(storeCopy(cache, url, copy, headers));
		return answer(body, headers, "miss");
	};
}

function answer(
	body: BodyInit | null,
	headers: Record<string, string>,
	outcome: CacheOutcome,
): Response {
	return new Response(body, {
		headers: { ...headers, [CACHE_OUTCOME_HEADER]: outcome },
	});
}

function isCacheable(answer: Response): boolean {
	return (
		answer.status === CACHEABLE_STATUS &&
		!declaresMoreThan(answer, LARGEST_CACHED_BYTES)
	);
}

function declaresMoreThan(answer: Response, limit: number): boolean {
	return declaredLength(answer) > limit;
}

function declaredLength(answer: Response): number {
	const length = Number(answer.headers.get("Content-Length"));
	return Number.isSafeInteger(length) && length > 0 ? length : 0;
}

async function storeCopy(
	cache: Cache,
	url: string,
	copy: Promise<Uint8Array | undefined>,
	headers: Record<string, string>,
): Promise<void> {
	const bytes = await copy;
	if (bytes !== undefined) {
		await ignoringCacheFailure(() =>
			cache.put(url, new Response(bytes, { headers })),
		);
	}
}

async function ignoringCacheFailure<T>(
	cacheCall: () => Promise<T>,
): Promise<T | undefined> {
	try {
		return await cacheCall();
	} catch {
		return undefined;
	}
}

function keepingACopy(
	source: ReadableStream<Uint8Array>,
	copy: BoundedCopy,
): CopiedStream {
	const reader = source.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					copy.complete();
					return;
				}
				copy.keep(value);
				controller.enqueue(value);
			} catch (error) {
				copy.abandon();
				controller.error(error);
			}
		},
		async cancel(reason) {
			copy.abandon();
			await reader.cancel(reason);
		},
	});
	return { body, copy: copy.bytes };
}

class BoundedCopy {
	private buffer: Uint8Array | undefined;
	private size = 0;
	private readonly finished = Promise.withResolvers<Uint8Array | undefined>();
	readonly bytes = this.finished.promise;

	constructor(
		private readonly limit: number,
		expectedSize: number,
	) {
		this.buffer = new Uint8Array(Math.min(expectedSize, limit));
	}

	keep(chunk: Uint8Array): void {
		if (this.buffer === undefined) {
			return;
		}
		const size = this.size + chunk.byteLength;
		if (size > this.limit) {
			this.abandon();
			return;
		}
		if (size > this.buffer.byteLength) {
			this.buffer = grown(this.buffer, this.size, size, this.limit);
		}
		this.buffer.set(chunk, this.size);
		this.size = size;
	}

	complete(): void {
		this.finished.resolve(this.buffer?.subarray(0, this.size));
	}

	abandon(): void {
		this.buffer = undefined;
		this.finished.resolve(undefined);
	}
}

function grown(
	buffer: Uint8Array,
	filled: number,
	needed: number,
	limit: number,
): Uint8Array {
	const larger = new Uint8Array(
		Math.min(limit, Math.max(needed, buffer.byteLength * 2)),
	);
	larger.set(buffer.subarray(0, filled));
	return larger;
}
