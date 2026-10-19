import { ARCHIVE_PATH, relayArchive } from "./archive";
import { isAllowedOrigin, withCorsHeadersFor } from "./cors";
import { type BackgroundWork, cachingRelay, type Relay } from "./edge-cache";
import { errorResponse } from "./errors";
import { createArchiveListing } from "./listing";
import type { Clock } from "./memo";
import { p2PackageName, relayP2 } from "./p2";
import type { QuotaCounter } from "./quota";
import { createQuotaGuard } from "./quota-guard";
import { createUpstream, type UpstreamFetch } from "./upstream";

const HEALTH_PATH = "/v1/health";
const STATUS_PATH = "/v1/status";
const ALLOWED_METHODS = ["GET", "HEAD", "OPTIONS"];
const PREFLIGHT_HEADERS = {
	"Access-Control-Allow-Methods": "GET, HEAD",
	"Access-Control-Max-Age": "86400",
};

const DEFAULT_UPSTREAM_TIMEOUT_MS = 25_000;

interface ProxyDependencies {
	fetch: UpstreamFetch;
	dailyQuota: QuotaCounter;
	upstreamTimeoutMs?: number;
	now?: Clock;
	githubToken?: string | undefined;
	edgeCache?: Cache | undefined;
}

type QuotaRule = "counted" | "exempt" | "countsItself";

interface Route {
	answersWithoutOrigin: boolean;
	quota: QuotaRule;
	answer(): Promise<Response>;
}

export function createProxy({
	fetch,
	dailyQuota,
	upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
	now = Date.now,
	githubToken,
	edgeCache,
}: ProxyDependencies) {
	const upstream = createUpstream(fetch, upstreamTimeoutMs, githubToken);
	const listing = createArchiveListing(upstream, now);
	const quotaGuard = createQuotaGuard(dailyQuota);

	function currentMoment(): Date {
		return new Date(now());
	}

	function relayFor(context: BackgroundWork | undefined): Relay {
		if (edgeCache === undefined || context === undefined) {
			return upstream.relay;
		}
		return cachingRelay(upstream, edgeCache, context);
	}

	function routeFor({ pathname, searchParams }: URL, relay: Relay): Route {
		if (pathname === HEALTH_PATH) {
			return {
				answersWithoutOrigin: true,
				quota: "exempt",
				answer: async () => health(),
			};
		}
		if (pathname === STATUS_PATH) {
			return {
				answersWithoutOrigin: true,
				quota: "countsItself",
				answer: () => quotaGuard.status(currentMoment()),
			};
		}
		const p2Name = p2PackageName(pathname);
		if (p2Name !== undefined) {
			return {
				answersWithoutOrigin: false,
				quota: "counted",
				answer: () => relayP2(relay, p2Name),
			};
		}
		if (pathname === ARCHIVE_PATH) {
			return {
				answersWithoutOrigin: false,
				quota: "counted",
				answer: () => relayArchive(relay, listing, searchParams),
			};
		}
		return {
			answersWithoutOrigin: true,
			quota: "counted",
			answer: async () => noSuchRoute(),
		};
	}

	async function answer(
		request: Request,
		route: Route,
		origin: string | null,
	): Promise<Response> {
		const refusal = refusalFor(request, route, origin);
		if (refusal !== undefined) {
			return refusal;
		}
		if (request.method === "OPTIONS") {
			return preflight();
		}
		return route.answer();
	}

	async function answerWithinQuota(
		request: Request,
		origin: string | null,
		relay: Relay,
	): Promise<Response> {
		const route = routeFor(new URL(request.url), relay);
		if (isExemptFromQuota(request, route)) {
			return answer(request, route, origin);
		}
		if (countsItself(request, route, origin)) {
			return route.answer();
		}
		return quotaGuard.admit(currentMoment(), () =>
			answer(request, route, origin),
		);
	}

	return {
		async fetch(
			request: Request,
			_env?: unknown,
			context?: BackgroundWork,
		): Promise<Response> {
			const origin = request.headers.get("Origin");
			const response = withCorsHeadersFor(
				origin,
				await answerWithinQuota(request, origin, relayFor(context)),
			);
			return request.method === "HEAD" ? withoutBody(response) : response;
		},
	} satisfies ExportedHandler;
}

async function withoutBody(response: Response): Promise<Response> {
	await response.body?.cancel();
	return new Response(null, response);
}

function isExemptFromQuota({ method }: Request, route: Route): boolean {
	return method === "OPTIONS" || route.quota === "exempt";
}

function countsItself(
	request: Request,
	route: Route,
	origin: string | null,
): boolean {
	return (
		route.quota === "countsItself" &&
		refusalFor(request, route, origin) === undefined
	);
}

function refusalFor(
	{ method }: Request,
	route: Route,
	origin: string | null,
): Response | undefined {
	if (!ALLOWED_METHODS.includes(method)) {
		return methodNotAllowed();
	}
	if (!originPermits(origin, route)) {
		return originNotAllowed();
	}
	return undefined;
}

function originPermits(origin: string | null, route: Route): boolean {
	return origin === null ? route.answersWithoutOrigin : isAllowedOrigin(origin);
}

function preflight(): Response {
	return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
}

function health(): Response {
	return Response.json({ ok: true });
}

function noSuchRoute(): Response {
	return errorResponse("not_found", "No route matches this path.");
}

function originNotAllowed(): Response {
	return errorResponse(
		"origin_not_allowed",
		"The proxy only answers requests from diffpack.io.",
	);
}

function methodNotAllowed(): Response {
	const response = errorResponse(
		"method_not_allowed",
		"The proxy only answers GET, HEAD and OPTIONS.",
	);
	response.headers.set("Allow", ALLOWED_METHODS.join(", "));
	return response;
}
