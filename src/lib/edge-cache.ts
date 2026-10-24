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

interface DeclaredLength {
	bytes: number;
	exact: boolean;
}

const UNDECLARED_LENGTH: DeclaredLength = { bytes: 0, exact: false };
const IDENTITY_ENCODING = "identity";

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
		return answerWithOutcome(fetched.answer.body, headers, "bypass");
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
			return answerWithOutcome(hit.body, headers, "hit");
		}
		const fetched = await upstream.fetchSuccess(url, githubApiUrl);
		if ("failure" in fetched) {
			return fetched.failure;
		}
		const source = fetched.answer.body;
		if (source === null || !isCacheable(fetched.answer)) {
			return answerWithOutcome(source, headers, "bypass");
		}
		const { body, copy } = keepingACopy(
			source,
			new BoundedCopy(LARGEST_CACHED_BYTES, declaredLengthOf(fetched.answer)),
		);
		background.waitUntil(storeCopy(cache, url, copy, headers));
		return answerWithOutcome(body, headers, "miss");
	};
}

function answerWithOutcome(
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
	return declaredLengthOf(answer).bytes > limit;
}

function declaredLengthOf(answer: Response): DeclaredLength {
	const bytes = Number(answer.headers.get("Content-Length"));
	if (!Number.isSafeInteger(bytes) || bytes <= 0) {
		return UNDECLARED_LENGTH;
	}
	return { bytes, exact: !isEncoded(answer) };
}

function isEncoded(answer: Response): boolean {
	const encoding = answer.headers.get("Content-Encoding")?.trim().toLowerCase();
	return (
		encoding !== undefined && encoding !== "" && encoding !== IDENTITY_ENCODING
	);
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
		private readonly declared: DeclaredLength,
	) {
		this.buffer = new Uint8Array(Math.min(declared.bytes, limit));
	}

	keep(chunk: Uint8Array): void {
		if (this.buffer === undefined) {
			return;
		}
		const size = this.size + chunk.byteLength;
		if (size > this.limit || this.overrunsDeclaredLength(size)) {
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
		if (this.fallsShortOfDeclaredLength()) {
			this.abandon();
			return;
		}
		this.finished.resolve(this.buffer?.subarray(0, this.size));
	}

	abandon(): void {
		this.buffer = undefined;
		this.finished.resolve(undefined);
	}

	private overrunsDeclaredLength(size: number): boolean {
		return this.declared.exact && size > this.declared.bytes;
	}

	private fallsShortOfDeclaredLength(): boolean {
		return this.declared.exact && this.size < this.declared.bytes;
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
