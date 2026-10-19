import { ARCHIVE_PATH, relayArchive } from "./archive";
import { isAllowedOrigin, withCorsHeadersFor } from "./cors";
import { errorResponse } from "./errors";
import { createArchiveListing } from "./listing";
import type { Clock } from "./memo";
import { p2PackageName, relayP2 } from "./p2";
import { type QuotaCounter, quotaExhausted } from "./quota";
import { createUpstream, type UpstreamFetch } from "./upstream";
import { isoTimestamp } from "./utc-day";

const HEALTH_PATH = "/v1/health";
const STATUS_PATH = "/v1/status";
const PATHS_OUTSIDE_QUOTA_GUARD = new Set([HEALTH_PATH, STATUS_PATH]);
const ALLOWED_METHODS = ["GET", "HEAD", "OPTIONS"];
const PREFLIGHT_HEADERS = {
	"Access-Control-Allow-Methods": "GET, HEAD",
	"Access-Control-Max-Age": "86400",
};

const DEFAULT_UPSTREAM_TIMEOUT_MS = 25_000;

interface ProxyDependencies {
	fetch: UpstreamFetch;
	dailyQuota: QuotaCounter;
	clock: () => Date;
	upstreamTimeoutMs?: number;
	now?: Clock;
}

interface Route {
	answersWithoutOrigin: boolean;
	answer(): Promise<Response>;
}

export function createProxy({
	fetch,
	dailyQuota,
	clock,
	upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
	now = Date.now,
}: ProxyDependencies) {
	const upstream = createUpstream(fetch, upstreamTimeoutMs);
	const listing = createArchiveListing(upstream, now);

	async function status(): Promise<Response> {
		const { allowed, used, budget, resetsAt } = await dailyQuota.take(clock());
		return Response.json({
			open: allowed,
			used,
			budget,
			resetsAt: isoTimestamp(resetsAt),
		});
	}

	function routeFor({ pathname, searchParams }: URL): Route {
		if (pathname === HEALTH_PATH) {
			return { answersWithoutOrigin: true, answer: async () => health() };
		}
		if (pathname === STATUS_PATH) {
			return { answersWithoutOrigin: true, answer: status };
		}
		const p2Name = p2PackageName(pathname);
		if (p2Name !== undefined) {
			return {
				answersWithoutOrigin: false,
				answer: () => relayP2(upstream, p2Name),
			};
		}
		if (pathname === ARCHIVE_PATH) {
			return {
				answersWithoutOrigin: false,
				answer: () => relayArchive(upstream, listing, searchParams),
			};
		}
		return { answersWithoutOrigin: true, answer: async () => noSuchRoute() };
	}

	async function answer(
		request: Request,
		url: URL,
		origin: string | null,
	): Promise<Response> {
		if (!ALLOWED_METHODS.includes(request.method)) {
			return methodNotAllowed();
		}
		const route = routeFor(url);
		if (!originPermits(origin, route)) {
			return originNotAllowed();
		}
		if (request.method === "OPTIONS") {
			return preflight();
		}
		return route.answer();
	}

	async function answerWithinQuota(
		request: Request,
		origin: string | null,
	): Promise<Response> {
		const url = new URL(request.url);
		if (bypassesQuotaGuard(url)) {
			return answer(request, url, origin);
		}
		const [ticket, response] = await Promise.all([
			dailyQuota.take(clock()),
			answer(request, url, origin),
		]);
		if (ticket.allowed) {
			return response;
		}
		await response.body?.cancel();
		return quotaExhausted(ticket.resetsAt);
	}

	return {
		async fetch(request: Request): Promise<Response> {
			const origin = request.headers.get("Origin");
			const response = withCorsHeadersFor(
				origin,
				await answerWithinQuota(request, origin),
			);
			return request.method === "HEAD" ? withoutBody(response) : response;
		},
	} satisfies ExportedHandler;
}

async function withoutBody(response: Response): Promise<Response> {
	await response.body?.cancel();
	return new Response(null, response);
}

function bypassesQuotaGuard({ pathname }: URL): boolean {
	return PATHS_OUTSIDE_QUOTA_GUARD.has(pathname);
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
