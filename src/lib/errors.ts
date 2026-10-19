const ERROR_HEADER = "Diffpack-Proxy-Error";

export type ProxyErrorCode = "not_found";

export function errorResponse(
	status: number,
	error: ProxyErrorCode,
	message: string,
): Response {
	return Response.json(
		{ error, message },
		{ status, headers: { [ERROR_HEADER]: error } },
	);
}
