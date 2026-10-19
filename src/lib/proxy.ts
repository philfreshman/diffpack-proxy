import { p2PackageName, relayP2 } from "./composer";
import { errorResponse } from "./errors";
import { createUpstream, type UpstreamFetch } from "./upstream";

const HEALTH_PATH = "/v1/health";
const ALLOWED_METHODS = ["GET", "HEAD", "OPTIONS"];

interface ProxyDependencies {
	fetch: UpstreamFetch;
}

export function createProxy({ fetch }: ProxyDependencies) {
	const upstream = createUpstream(fetch);
	return {
		async fetch(request: Request): Promise<Response> {
			if (!ALLOWED_METHODS.includes(request.method)) {
				return methodNotAllowed();
			}
			const { pathname } = new URL(request.url);
			if (pathname === HEALTH_PATH) {
				return Response.json({ ok: true });
			}
			const p2Name = p2PackageName(pathname);
			if (p2Name !== undefined) {
				return relayP2(upstream, p2Name);
			}
			return errorResponse("not_found", "No route matches this path.");
		},
	} satisfies ExportedHandler;
}

function methodNotAllowed(): Response {
	const response = errorResponse(
		"method_not_allowed",
		"The proxy only answers GET, HEAD and OPTIONS.",
	);
	response.headers.set("Allow", ALLOWED_METHODS.join(", "));
	return response;
}
