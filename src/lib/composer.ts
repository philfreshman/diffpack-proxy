import { errorResponse } from "./errors";
import { isComposerPackageName } from "./package-name";
import type { Upstream } from "./upstream";

const P2_PATH = /^\/v1\/composer\/p2\/(.+)\.json$/;
const P2_HEADERS = {
	"Content-Type": "application/json",
	"Cache-Control": "public, max-age=300",
};

export function p2PackageName(pathname: string): string | undefined {
	return P2_PATH.exec(pathname)?.[1];
}

export async function relayP2(
	upstream: Upstream,
	name: string,
): Promise<Response> {
	if (!isComposerPackageName(name)) {
		return invalidPackageName();
	}
	return upstream.relay(
		`https://repo.packagist.org/p2/${name}.json`,
		P2_HEADERS,
	);
}

export function invalidPackageName(): Response {
	return errorResponse(
		"invalid_request",
		"The package name is not a valid Composer name.",
	);
}
