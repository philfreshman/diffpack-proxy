import { errorResponse } from "./errors";
import { p2SourceUrl } from "./p2";
import type { Upstream } from "./upstream";

export type ArchiveListing = ReturnType<typeof createArchiveListing>;

export function createArchiveListing(upstream: Upstream) {
	return {
		async refusalFor(
			packageName: string,
			distUrl: string,
		): Promise<Response | undefined> {
			const p2 = await upstream.text(p2SourceUrl(packageName));
			if ("failure" in p2) {
				return p2.failure;
			}
			return listsArchive(p2.text, distUrl) ? undefined : archiveNotListed();
		},
	};
}

function listsArchive(p2Text: string, distUrl: string): boolean {
	return p2Text.includes(JSON.stringify(distUrl));
}

function archiveNotListed(): Response {
	return errorResponse(
		"archive_not_listed",
		"This archive is not one Packagist lists for the package.",
	);
}
