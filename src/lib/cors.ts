const PRODUCTION_ORIGINS = new Set([
	"https://diffpack.io",
	"https://www.diffpack.io",
]);
const LOCAL_DEVELOPMENT_ORIGIN =
	/^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/;
const EXPOSED_HEADERS = "Retry-After, Diffpack-Proxy-Error";

export function isAllowedOrigin(origin: string): boolean {
	return (
		PRODUCTION_ORIGINS.has(origin) || LOCAL_DEVELOPMENT_ORIGIN.test(origin)
	);
}

export function withCorsHeadersFor(
	origin: string | null,
	response: Response,
): Response {
	if (origin === null || !isAllowedOrigin(origin)) {
		return response;
	}
	const withCors = new Response(response.body, response);
	withCors.headers.set("Access-Control-Allow-Origin", origin);
	withCors.headers.set("Vary", "Origin");
	withCors.headers.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
	return withCors;
}
