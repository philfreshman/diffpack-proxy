const ERROR_HEADER = "Diffpack-Proxy-Error";

const STATUS_BY_CODE = {
	invalid_request: 400,
	unsupported_archive_host: 400,
	origin_not_allowed: 403,
	archive_not_listed: 403,
	not_found: 404,
	method_not_allowed: 405,
	upstream_failed: 502,
} as const satisfies Record<string, number>;

export type ProxyErrorCode = keyof typeof STATUS_BY_CODE;

type ErrorDetails = Record<string, string | number>;

export function errorResponse(
	error: ProxyErrorCode,
	message: string,
	details: ErrorDetails = {},
): Response {
	return Response.json(
		{ error, message, ...details },
		{ status: STATUS_BY_CODE[error], headers: { [ERROR_HEADER]: error } },
	);
}
