import { errorResponse } from "./errors";
import { type Clock, createMemo } from "./memo";
import { p2SourceUrl } from "./p2";
import type { Upstream, UpstreamText } from "./upstream";

export type ArchiveListing = ReturnType<typeof createArchiveListing>;

const P2_TEXT_LIFETIME_MS = 5 * 60_000;
const P2_TEXT_CAPACITY = 8 * 1024 * 1024;
const VERIFIED_ARCHIVE_LIFETIME_MS = 10 * 60_000;
const VERIFIED_ARCHIVE_CAPACITY = 1024 * 1024;

export function createArchiveListing(upstream: Upstream, now: Clock) {
	const p2Texts = createMemo<string>({
		lifetimeMs: P2_TEXT_LIFETIME_MS,
		capacity: P2_TEXT_CAPACITY,
		sizeOf: (_packageName, text) => text.length,
		now,
	});
	const verifiedArchives = createMemo<true>({
		lifetimeMs: VERIFIED_ARCHIVE_LIFETIME_MS,
		capacity: VERIFIED_ARCHIVE_CAPACITY,
		sizeOf: (pair) => pair.length,
		now,
	});

	async function p2TextOf(packageName: string): Promise<UpstreamText> {
		const remembered = p2Texts.get(packageName);
		if (remembered !== undefined) {
			return { text: remembered };
		}
		const p2 = await upstream.text(p2SourceUrl(packageName));
		if ("text" in p2) {
			p2Texts.set(packageName, p2.text);
		}
		return p2;
	}

	return {
		async refusalFor(
			packageName: string,
			distUrl: string,
		): Promise<Response | undefined> {
			const pair = `${packageName} ${distUrl}`;
			if (verifiedArchives.get(pair)) {
				return undefined;
			}
			const p2 = await p2TextOf(packageName);
			if ("failure" in p2) {
				return p2.failure;
			}
			if (!listsArchive(p2.text, distUrl)) {
				return archiveNotListed();
			}
			verifiedArchives.set(pair, true);
			return undefined;
		},
	};
}

function listsArchive(p2Text: string, distUrl: string): boolean {
	const asJsonString = JSON.stringify(distUrl);
	const withEscapedSlashes = asJsonString.replaceAll("/", "\\/");
	return p2Text.includes(asJsonString) || p2Text.includes(withEscapedSlashes);
}

function archiveNotListed(): Response {
	return errorResponse(
		"archive_not_listed",
		"This archive is not one Packagist lists for the package.",
	);
}
