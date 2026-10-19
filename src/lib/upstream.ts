import { errorResponse } from "./errors";

export type UpstreamFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

export type Upstream = ReturnType<typeof createUpstream>;

const NOT_FOUND = 404;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const UPSTREAM_HOSTS = new Set([
	"repo.packagist.org",
	"codeload.github.com",
	"bitbucket.org",
	"gitlab.com",
]);
const USER_AGENT = "diffpack-proxy (+https://diffpack.io)";

export function createUpstream(fetch: UpstreamFetch, timeoutMs: number) {
	async function fetchOrUndefined(
		url: string,
		signal: AbortSignal,
	): Promise<Response | undefined> {
		try {
			return await fetch(url, {
				headers: { "User-Agent": USER_AGENT },
				redirect: "manual",
				signal,
			});
		} catch {
			return undefined;
		}
	}

	async function fetchFollowingRedirects(
		url: string,
		signal: AbortSignal,
		redirectsLeft = MAX_REDIRECTS,
	): Promise<Response | undefined> {
		const answer = await fetchOrUndefined(url, signal);
		if (answer === undefined || redirectsLeft === 0) {
			return answer;
		}
		const target = allowedRedirectTarget(answer, url);
		if (target === undefined) {
			return answer;
		}
		await answer.body?.cancel();
		return fetchFollowingRedirects(target, signal, redirectsLeft - 1);
	}

	async function fetchHeadersInTime(
		url: string,
	): Promise<Response | undefined> {
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), timeoutMs);
		try {
			return await fetchFollowingRedirects(url, deadline.signal);
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		async relay(url: string, headers: HeadersInit): Promise<Response> {
			const answer = await fetchHeadersInTime(url);
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

function allowedRedirectTarget(
	answer: Response,
	from: string,
): string | undefined {
	const location = answer.headers.get("Location");
	if (!REDIRECT_STATUSES.has(answer.status) || location === null) {
		return undefined;
	}
	if (!URL.canParse(location, from)) {
		return undefined;
	}
	const target = new URL(location, from);
	return isUpstreamUrl(target) ? target.href : undefined;
}

function isUpstreamUrl(url: URL): boolean {
	return (
		url.protocol === "https:" &&
		url.username === "" &&
		url.password === "" &&
		url.port === "" &&
		UPSTREAM_HOSTS.has(url.hostname)
	);
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
