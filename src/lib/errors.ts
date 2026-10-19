const ERROR_HEADER = "Diffpack-Proxy-Error";

const STATUS_BY_CODE = {
	not_found: 404,
	method_not_allowed: 405,
} as const satisfies Record<string, number>;

export type ProxyErrorCode = keyof typeof STATUS_BY_CODE;

export function errorResponse(
	error: ProxyErrorCode,
	message: string,
): Response {
	return Response.json(
		{ error, message },
		{ status: STATUS_BY_CODE[error], headers: { [ERROR_HEADER]: error } },
	);
}
