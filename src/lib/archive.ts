import { errorResponse } from "./errors";
import { invalidPackageName, isComposerPackageName } from "./package-name";
import type { Upstream } from "./upstream";

export const ARCHIVE_PATH = "/v1/composer/archive";
const ARCHIVE_HEADERS = {
	"Content-Type": "application/zip",
	"Cache-Control": "public, max-age=31536000, immutable",
};

interface ArchiveHost {
	listedUrl: RegExp;
	sourceUrl(listed: RegExpExecArray): string;
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

export async function relayArchive(
	upstream: Upstream,
	params: URLSearchParams,
): Promise<Response> {
	if (!isComposerPackageName(params.get("package"))) {
		return invalidPackageName();
	}
	const distUrls = params.getAll("url");
	const [distUrl] = distUrls;
	if (distUrls.length !== 1 || distUrl === undefined) {
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
	return upstream.relay(source, ARCHIVE_HEADERS);
}

function hostnameOf(url: string): string | undefined {
	return URL.canParse(url) ? new URL(url).hostname : undefined;
}

function archiveSourceFor(distUrl: string): string | undefined {
	for (const host of ARCHIVE_HOSTS) {
		const listed = host.listedUrl.exec(distUrl);
		if (listed?.slice(1).every(isPlainSegment)) {
			return host.sourceUrl(listed);
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
