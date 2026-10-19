import type { Relay } from "./edge-cache";
import { errorResponse } from "./errors";
import type { ArchiveListing } from "./listing";
import { invalidPackageName, isComposerPackageName } from "./package-name";

export const ARCHIVE_PATH = "/v1/composer/archive";
const ARCHIVE_HEADERS = {
	"Content-Type": "application/zip",
	"Cache-Control": "public, max-age=31536000, immutable",
};

interface ArchiveHost {
	listedUrl: RegExp;
	sourceUrl(listed: RegExpExecArray): string;
	githubApiUrl?(listed: RegExpExecArray): string;
}

const SEGMENT = "([A-Za-z0-9_.-]+)";
const COMMIT_SHA = "([0-9a-fA-F]{40})";
const ABBREVIATED_SHA = "([0-9a-fA-F]{7,40})";
const GITLAB_PROJECT = "([A-Za-z0-9%._-]+)";
const DOT_SEGMENTS = new Set([".", ".."]);

const ARCHIVE_HOSTS: ArchiveHost[] = [
	{
		listedUrl: new RegExp(
			`^https://api\\.github\\.com/repos/${SEGMENT}/${SEGMENT}/zipball/${COMMIT_SHA}$`,
		),
		sourceUrl: ([, owner, repo, sha]) =>
			`https://codeload.github.com/${owner}/${repo}/legacy.zip/${sha}`,
		githubApiUrl: ([listed]) => listed,
	},
	{
		listedUrl: new RegExp(
			`^https://bitbucket\\.org/${SEGMENT}/${SEGMENT}/get/${ABBREVIATED_SHA}\\.zip$`,
		),
		sourceUrl: ([listed]) => listed,
	},
	{
		listedUrl: new RegExp(
			`^https://gitlab\\.com/api/v4/projects/${GITLAB_PROJECT}/repository/archive\\.zip\\?sha=${COMMIT_SHA}$`,
		),
		sourceUrl: ([listed]) => listed,
	},
];

interface ArchiveSource {
	url: string;
	githubApiUrl?: string | undefined;
}

interface ArchiveRequest {
	packageName: string;
	distUrl: string;
	source: ArchiveSource;
}

export async function relayArchive(
	relay: Relay,
	listing: ArchiveListing,
	params: URLSearchParams,
): Promise<Response> {
	const request = archiveRequestFrom(params);
	if (request instanceof Response) {
		return request;
	}
	const refusal = await listing.refusalFor(
		request.packageName,
		request.distUrl,
	);
	return (
		refusal ??
		relay(request.source.url, ARCHIVE_HEADERS, request.source.githubApiUrl)
	);
}

function archiveRequestFrom(
	params: URLSearchParams,
): ArchiveRequest | Response {
	const packageName = singleValue(params, "package");
	if (!isComposerPackageName(packageName)) {
		return invalidPackageName();
	}
	const distUrl = singleValue(params, "url");
	if (distUrl === undefined) {
		return invalidArchiveUrl();
	}
	const host = hostnameOf(distUrl);
	if (host === undefined) {
		return invalidArchiveUrl();
	}
	const source = archiveSourceFor(distUrl);
	if (source === undefined) {
		return unsupportedArchiveHost(host);
	}
	return { packageName, distUrl, source };
}

function singleValue(
	params: URLSearchParams,
	name: string,
): string | undefined {
	const values = params.getAll(name);
	return values.length === 1 ? values[0] : undefined;
}

function hostnameOf(url: string): string | undefined {
	return URL.canParse(url) ? new URL(url).hostname : undefined;
}

function archiveSourceFor(distUrl: string): ArchiveSource | undefined {
	for (const host of ARCHIVE_HOSTS) {
		const listed = host.listedUrl.exec(distUrl);
		if (listed?.slice(1).every(isPlainSegment)) {
			return {
				url: host.sourceUrl(listed),
				githubApiUrl: host.githubApiUrl?.(listed),
			};
		}
	}
	return undefined;
}

function isPlainSegment(segment: string): boolean {
	try {
		return !DOT_SEGMENTS.has(decodeURIComponent(segment));
	} catch {
		return false;
	}
}

function invalidArchiveUrl(): Response {
	return errorResponse(
		"invalid_request",
		"The url parameter must be one archive URL from Packagist.",
	);
}

function unsupportedArchiveHost(host: string): Response {
	return errorResponse(
		"unsupported_archive_host",
		"The proxy only fetches archives from GitHub, Bitbucket and gitlab.com.",
		{ host },
	);
}
