import type { Upstream } from "./upstream";

export type Relay = (
	url: string,
	headers: Record<string, string>,
	githubApiUrl?: string,
) => Promise<Response>;

export type BackgroundWork = Pick<ExecutionContext, "waitUntil">;

export function cachingRelay(
	upstream: Upstream,
	cache: Cache,
	context: BackgroundWork,
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
		const [forClient, forCache] = fetched.answer.body?.tee() ?? [null, null];
		context.waitUntil(cache.put(url, new Response(forCache, { headers })));
		return new Response(forClient, { headers });
	};
}
