import { errorResponse } from "./errors";

const HEALTH_PATH = "/v1/health";

export function createProxy() {
	return {
		fetch(request: Request): Response {
			const { pathname } = new URL(request.url);
			if (pathname === HEALTH_PATH) {
				return Response.json({ ok: true });
			}
			return errorResponse(404, "not_found", "No route matches this path.");
		},
	} satisfies ExportedHandler;
}
