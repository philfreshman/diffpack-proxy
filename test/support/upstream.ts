import { createProxy } from "../../src/lib/proxy";

export const PROXY = "https://proxy.test";
export const ALLOWED_ORIGIN = "https://diffpack.io";

interface UpstreamCall {
	url: string;
	init: RequestInit;
}

type UpstreamAnswers = Record<string, () => Response>;

export function stubUpstream(answers: UpstreamAnswers = {}) {
	const calls: UpstreamCall[] = [];
	async function fetch(url: string, init: RequestInit): Promise<Response> {
		calls.push({ url, init });
		const answer = answers[url];
		if (answer === undefined) {
			throw new TypeError("Network connection lost.");
		}
		return answer();
	}
	return { fetch, calls };
}

interface ProxyRequestInit extends RequestInit {
	origin?: string | null;
}

export function proxyRequest(
	upstream: ReturnType<typeof stubUpstream>,
	path: string,
	{ origin = ALLOWED_ORIGIN, ...init }: ProxyRequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (origin !== null) {
		headers.set("Origin", origin);
	}
	const proxy = createProxy({ fetch: upstream.fetch });
	return proxy.fetch(new Request(`${PROXY}${path}`, { ...init, headers }));
}
