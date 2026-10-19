import { errorResponse } from "./errors";

const HEALTH_PATH = "/v1/health";
const ALLOWED_METHODS = ["GET", "HEAD", "OPTIONS"];

export function createProxy() {
	return {
		fetch(request: Request): Response {
			if (!ALLOWED_METHODS.includes(request.method)) {
				return methodNotAllowed();
			}
			const { pathname } = new URL(request.url);
			if (pathname === HEALTH_PATH) {
				return Response.json({ ok: true });
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
