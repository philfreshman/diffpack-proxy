import { invalidPackageName, isComposerPackageName } from "./package-name";
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
	return upstream.relay(p2SourceUrl(name), P2_HEADERS);
}

export function p2SourceUrl(name: string): string {
	return `https://repo.packagist.org/p2/${name}.json`;
}
