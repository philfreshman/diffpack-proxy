import { errorResponse } from "./errors";

export type UpstreamFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

export type Upstream = ReturnType<typeof createUpstream>;

type UpstreamFailure = { failure: Response };
type UpstreamSuccess = { answer: Response } | UpstreamFailure;
export type UpstreamText = { text: string } | UpstreamFailure;
type Credentials = Record<string, string>;

const NOT_FOUND = 404;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const UPSTREAM_HOSTS = new Set([
	"repo.packagist.org",
	"codeload.github.com",
	"bitbucket.org",
	"gitlab.com",
	"pkg.go.dev",
]);
const USER_AGENT = "diffpack-proxy (+https://diffpack.io)";
const GITHUB_THROTTLE_STATUSES = new Set([403, 429]);

export function createUpstream(
	fetch: UpstreamFetch,
	timeoutMs: number,
	githubToken?: string,
) {
	const githubCredentials = githubCredentialsFor(githubToken);

	async function fetchOrUndefined(
		url: string,
		signal: AbortSignal,
		credentials: Credentials = {},
	): Promise<Response | undefined> {
		try {
			return await fetch(url, {
				headers: { ...credentials, "User-Agent": USER_AGENT },
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
		credentials: Credentials = {},
		redirectsLeft = MAX_REDIRECTS,
	): Promise<Response | undefined> {
		const answer = await fetchOrUndefined(url, signal, credentials);
		if (answer === undefined || redirectsLeft === 0) {
			return answer;
		}
		const target = allowedRedirectTarget(answer, url);
		if (target === undefined) {
			return answer;
		}
		await answer.body?.cancel();
		return fetchFollowingRedirects(target, signal, {}, redirectsLeft - 1);
	}

	async function fetchHeadersInTime(
		url: string,
		credentials: Credentials = {},
	): Promise<Response | undefined> {
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), timeoutMs);
		try {
			return await fetchFollowingRedirects(url, deadline.signal, credentials);
		} finally {
			clearTimeout(timer);
		}
	}

	async function fetchFallingBackToGitHubApi(
		url: string,
		githubApiUrl: string | undefined,
	): Promise<Response | undefined> {
		const answer = await fetchHeadersInTime(url);
		if (
			githubCredentials === undefined ||
			githubApiUrl === undefined ||
			!isThrottled(answer)
		) {
			return answer;
		}
		await answer.body?.cancel();
		return fetchHeadersInTime(githubApiUrl, githubCredentials);
	}

	async function fetchSuccess(
		url: string,
		githubApiUrl?: string,
	): Promise<UpstreamSuccess> {
		const answer = await fetchFallingBackToGitHubApi(url, githubApiUrl);
		if (answer === undefined) {
			return { failure: upstreamFailed() };
		}
		if (!answer.ok) {
			await answer.body?.cancel();
			return { failure: failureFor(answer.status) };
		}
		return { answer };
	}

	return {
		fetchSuccess,

		async text(url: string): Promise<UpstreamText> {
			const fetched = await fetchSuccess(url);
			if ("failure" in fetched) {
				return fetched;
			}
			return readText(fetched.answer);
		},
	};
}

function githubCredentialsFor(
	token: string | undefined,
): Credentials | undefined {
	const trimmed = token?.trim();
	return trimmed ? { Authorization: `Bearer ${trimmed}` } : undefined;
}

function isThrottled(answer: Response | undefined): answer is Response {
	return answer !== undefined && GITHUB_THROTTLE_STATUSES.has(answer.status);
}

async function readText(answer: Response): Promise<UpstreamText> {
	try {
		return { text: await answer.text() };
	} catch {
		return { failure: upstreamFailed() };
	}
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
