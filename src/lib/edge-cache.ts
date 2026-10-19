import type { Upstream } from "./upstream";

export type Relay = (
	url: string,
	headers: Record<string, string>,
	githubApiUrl?: string,
) => Promise<Response>;

const LARGEST_CACHED_BYTES = 5 * 1024 * 1024;

export type BackgroundWork = Pick<ExecutionContext, "waitUntil">;

interface CopiedStream {
	body: ReadableStream<Uint8Array>;
	copy: Promise<Uint8Array | undefined>;
}

export function cachingRelay(
	upstream: Upstream,
	cache: Cache,
	background: BackgroundWork,
): Relay {
	return async (url, headers, githubApiUrl) => {
		const hit = await cache.match(url);
		if (hit !== undefined) {
			return new Response(hit.body, { headers });
		}
		const fetched = await upstream.fetchSuccess(url, githubApiUrl);
		if ("failure" in fetched) {
			return fetched.failure;
		}
		if (declaresMoreThan(fetched.answer, LARGEST_CACHED_BYTES)) {
			return new Response(fetched.answer.body, { headers });
		}
		const { body, copy } = keepingACopy(
			fetched.answer.body,
			LARGEST_CACHED_BYTES,
		);
		background.waitUntil(storeCopy(cache, url, copy, headers));
		return new Response(body, { headers });
	};
}

function declaresMoreThan(answer: Response, limit: number): boolean {
	return Number(answer.headers.get("Content-Length")) > limit;
}

async function storeCopy(
	cache: Cache,
	url: string,
	copy: Promise<Uint8Array | undefined>,
	headers: Record<string, string>,
): Promise<void> {
	const bytes = await copy;
	if (bytes !== undefined) {
		await cache.put(url, new Response(bytes, { headers }));
	}
}

function keepingACopy(
	source: ReadableStream<Uint8Array> | null,
	limit: number,
): CopiedStream {
	const reader = (source ?? new ReadableStream()).getReader();
	const copy = new BoundedCopy(limit);
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
	private chunks: Uint8Array[] | undefined = [];
	private size = 0;
	private readonly finished = Promise.withResolvers<Uint8Array | undefined>();
	readonly bytes = this.finished.promise;

	constructor(private readonly limit: number) {}

	keep(chunk: Uint8Array): void {
		this.size += chunk.byteLength;
		if (this.size > this.limit) {
			this.abandon();
			return;
		}
		this.chunks?.push(chunk);
	}

	complete(): void {
		this.finished.resolve(this.chunks && joined(this.chunks));
	}

	abandon(): void {
		this.chunks = undefined;
		this.finished.resolve(undefined);
	}
}

function joined(chunks: Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(
		chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
	);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
