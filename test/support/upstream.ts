import { createProxy } from "../../src/lib/proxy";
import type { QuotaCounter } from "../../src/lib/quota";
import { freshDailyQuota } from "./quota";

export const PROXY = "https://proxy.test";
export const ALLOWED_ORIGIN = "https://diffpack.io";

interface UpstreamCall {
	url: string;
	init: RequestInit;
}

type UpstreamAnswers = Record<
	string,
	(init: RequestInit) => Response | Promise<Response>
>;

export function stubUpstream(answers: UpstreamAnswers = {}) {
	const calls: UpstreamCall[] = [];
	async function fetch(url: string, init: RequestInit): Promise<Response> {
		calls.push({ url, init });
		const answer = answers[url];
		if (answer === undefined) {
			throw new TypeError("Network connection lost.");
		}
		return answer(init);
	}
	return { fetch, calls };
}

export function manualClock() {
	let time = Date.UTC(2026, 9, 19, 12);
	return {
		now: () => time,
		advanceMinutes(minutes: number) {
			time += minutes * 60_000;
		},
	};
}

interface ProxyRequestInit extends RequestInit {
	origin?: string | null;
}

interface TestProxyOptions {
	now?: () => number;
	dailyQuota?: QuotaCounter | undefined;
	githubToken?: string | undefined;
}

export function proxyFor(
	upstream: ReturnType<typeof stubUpstream>,
	{
		now = Date.now,
		dailyQuota = freshDailyQuota(),
		githubToken,
	}: TestProxyOptions = {},
) {
	const proxy = createProxy({
		fetch: upstream.fetch,
		dailyQuota,
		now,
		githubToken,
	});
	return (
		path: string,
		{ origin = ALLOWED_ORIGIN, ...init }: ProxyRequestInit = {},
	): Promise<Response> => {
		const headers = new Headers(init.headers);
		if (origin !== null) {
			headers.set("Origin", origin);
		}
		return proxy.fetch(new Request(`${PROXY}${path}`, { ...init, headers }));
	};
}

interface SingleRequestInit extends ProxyRequestInit {
	dailyQuota?: QuotaCounter;
	githubToken?: string;
}

export function proxyRequest(
	upstream: ReturnType<typeof stubUpstream>,
	path: string,
	{ dailyQuota, githubToken, ...init }: SingleRequestInit = {},
): Promise<Response> {
	return proxyFor(upstream, { dailyQuota, githubToken })(path, init);
}
