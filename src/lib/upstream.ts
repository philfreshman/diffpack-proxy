import { errorResponse } from "./errors";

export type UpstreamFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

export type Upstream = ReturnType<typeof createUpstream>;

const NOT_FOUND = 404;
const UPSTREAM_REQUEST: RequestInit = {
	headers: { "User-Agent": "diffpack-proxy (+https://diffpack.io)" },
	redirect: "manual",
};

export function createUpstream(fetch: UpstreamFetch) {
	async function fetchOrUndefined(url: string): Promise<Response | undefined> {
		try {
			return await fetch(url, UPSTREAM_REQUEST);
		} catch {
			return undefined;
		}
	}

	return {
		async relay(url: string, headers: HeadersInit): Promise<Response> {
			const answer = await fetchOrUndefined(url);
			if (answer === undefined) {
				return upstreamFailed();
			}
			if (!answer.ok) {
				await answer.body?.cancel();
				return failureFor(answer.status);
			}
			return new Response(answer.body, { headers });
		},
	};
}

function failureFor(upstreamStatus: number): Response {
	if (upstreamStatus === NOT_FOUND) {
		return errorResponse("not_found", "The upstream server has no such file.");
	}
	return upstreamFailed({ upstreamStatus });
}

function upstreamFailed(details: { upstreamStatus?: number } = {}): Response {
	return errorResponse(
		"upstream_failed",
		"The upstream server could not answer.",
		details,
	);
}
