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
		const { body, copy } = keepingACopy(fetched.answer.body);
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

function keepingACopy(source: ReadableStream<Uint8Array> | null): CopiedStream {
	const reader = (source ?? new ReadableStream()).getReader();
	const chunks: Uint8Array[] = [];
	const { promise: copy, resolve: finish } = Promise.withResolvers<
		Uint8Array | undefined
	>();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					finish(joined(chunks));
					return;
				}
				chunks.push(value);
				controller.enqueue(value);
			} catch (error) {
				finish(undefined);
				controller.error(error);
			}
		},
		async cancel(reason) {
			finish(undefined);
			await reader.cancel(reason);
		},
	});
	return { body, copy };
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
