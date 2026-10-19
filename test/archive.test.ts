import { describe, expect, it } from "vitest";
import { proxyRequest, stubUpstream } from "./support/upstream";

const SHA = "d7059e4c691d05ea1222b5124bed0f961be46e15";
const GITHUB_DIST = `https://api.github.com/repos/Seldaek/monolog/zipball/${SHA}`;
const CODELOAD = `https://codeload.github.com/Seldaek/monolog/legacy.zip/${SHA}`;
const BITBUCKET_DIST =
	"https://bitbucket.org/yicr/php-simple-json-api-client/get/562476a383c97a54a78e1f7af40c923f72d22dce.zip";
const GITLAB_DIST =
	"https://gitlab.com/api/v4/projects/consensus%2Eenterprises%2Fmisc%2Fbehat-drupal-context/repository/archive.zip?sha=c708cef19ea3db108a1683e857a5bf1712377a9e";
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);

function archivePath(params: Record<string, string>): string {
	return `/v1/composer/archive?${new URLSearchParams(params)}`;
}

function servingZipAt(url: string) {
	return stubUpstream({
		[url]: () =>
			new Response(ZIP_BYTES, {
				headers: { "Content-Type": "application/octet-stream" },
			}),
	});
}

describe("GET /v1/composer/archive", () => {
	it("fetches a GitHub archive from codeload and streams it back", async () => {
		const upstream = servingZipAt(CODELOAD);

		const response = await proxyRequest(
			upstream,
			archivePath({ package: "monolog/monolog", url: GITHUB_DIST }),
		);

		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(ZIP_BYTES);
		expect(response.headers.get("Content-Type")).toBe("application/zip");
		expect(response.headers.get("Cache-Control")).toBe(
			"public, max-age=31536000, immutable",
		);
		expect(upstream.calls.map((call) => call.url)).toEqual([CODELOAD]);
	});

	it.each([
		["Bitbucket", "yicr/php-simple-json-api-client", BITBUCKET_DIST],
		["gitlab.com", "consensus/behat-drupal-context", GITLAB_DIST],
	])("fetches a %s archive from the listed URL", async (_, name, dist) => {
		const upstream = servingZipAt(dist);

		const response = await proxyRequest(
			upstream,
			archivePath({ package: name, url: dist }),
		);

		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(ZIP_BYTES);
		expect(response.headers.get("Content-Type")).toBe("application/zip");
		expect(upstream.calls.map((call) => call.url)).toEqual([dist]);
	});
});

describe("HEAD /v1/composer/archive", () => {
	it("answers with the archive headers and no body", async () => {
		const response = await proxyRequest(
			servingZipAt(CODELOAD),
			archivePath({ package: "monolog/monolog", url: GITHUB_DIST }),
			{ method: "HEAD" },
		);

		expect(response.status).toBe(200);
		expect(response.body).toBeNull();
		expect(response.headers.get("Content-Type")).toBe("application/zip");
		expect(response.headers.get("Cache-Control")).toBe(
			"public, max-age=31536000, immutable",
		);
	});
});

describe("a hostile archive url", () => {
	const github = (path: string) => `https://api.github.com/repos/${path}`;

	it.each([
		[
			"http instead of https",
			`http://api.github.com/repos/Seldaek/monolog/zipball/${SHA}`,
			"api.github.com",
		],
		[
			"another host",
			`https://git.drupalcode.org/project/x/-/archive/${SHA}.zip`,
			"git.drupalcode.org",
		],
		[
			"a lookalike host",
			`https://api.github.com.evil.example/repos/Seldaek/monolog/zipball/${SHA}`,
			"api.github.com.evil.example",
		],
		[
			"user info",
			`https://x@api.github.com/repos/Seldaek/monolog/zipball/${SHA}`,
			"api.github.com",
		],
		[
			"a port",
			`https://api.github.com:8443/repos/Seldaek/monolog/zipball/${SHA}`,
			"api.github.com",
		],
		[
			"the default port spelled out",
			`https://api.github.com:443/repos/Seldaek/monolog/zipball/${SHA}`,
			"api.github.com",
		],
		[
			"a non-hex SHA",
			github(`Seldaek/monolog/zipball/${"g".repeat(40)}`),
			"api.github.com",
		],
		[
			"a short SHA",
			github(`Seldaek/monolog/zipball/${SHA.slice(0, 39)}`),
			"api.github.com",
		],
		[
			"a short Bitbucket ref",
			"https://bitbucket.org/yicr/x/get/562476.zip",
			"bitbucket.org",
		],
		["a dot-dot owner", github(`../monolog/zipball/${SHA}`), "api.github.com"],
		["a dot-dot repo", github(`Seldaek/../zipball/${SHA}`), "api.github.com"],
		["a dot owner", github(`./monolog/zipball/${SHA}`), "api.github.com"],
		[
			"a dot-dot Bitbucket repo",
			`https://bitbucket.org/yicr/../get/${SHA}.zip`,
			"bitbucket.org",
		],
		[
			"a dot-dot GitLab project",
			`https://gitlab.com/api/v4/projects/../repository/archive.zip?sha=${SHA}`,
			"gitlab.com",
		],
		[
			"a percent-encoded dot-dot GitLab project",
			`https://gitlab.com/api/v4/projects/%2E%2E/repository/archive.zip?sha=${SHA}`,
			"gitlab.com",
		],
		[
			"a percent-encoded slash in the owner",
			github(`Seldaek%2Fmonolog/x/zipball/${SHA}`),
			"api.github.com",
		],
		[
			"a percent-encoded slash in the repo",
			github(`Seldaek/monolog%2F..%2F..%2Fx/zipball/${SHA}`),
			"api.github.com",
		],
		[
			"an extra query parameter",
			github(`Seldaek/monolog/zipball/${SHA}?access_token=x`),
			"api.github.com",
		],
		[
			"an extra GitLab query parameter",
			`https://gitlab.com/api/v4/projects/1/repository/archive.zip?sha=${SHA}&private_token=x`,
			"gitlab.com",
		],
		[
			"a fragment",
			github(`Seldaek/monolog/zipball/${SHA}#x`),
			"api.github.com",
		],
		[
			"a trailing newline",
			github(`Seldaek/monolog/zipball/${SHA}\n`),
			"api.github.com",
		],
	])("with %s is refused as unsupported_archive_host", async (_, url, host) => {
		const upstream = stubUpstream();

		const response = await proxyRequest(
			upstream,
			archivePath({ package: "monolog/monolog", url }),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "unsupported_archive_host",
			message: expect.any(String),
			host,
		});
		expect(upstream.calls).toEqual([]);
	});

	it.each([
		["missing", archivePath({ package: "monolog/monolog" })],
		["not a URL", archivePath({ package: "monolog/monolog", url: "zipball" })],
		[
			"given twice",
			`${archivePath({ package: "monolog/monolog", url: GITHUB_DIST })}&${new URLSearchParams({ url: GITHUB_DIST })}`,
		],
	])("that is %s is refused as invalid_request", async (_, path) => {
		const upstream = stubUpstream();

		const response = await proxyRequest(upstream, path);

		expect(response.status).toBe(400);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"invalid_request",
		);
		expect(upstream.calls).toEqual([]);
	});
});

describe("a hostile archive package", () => {
	it.each([
		["uppercase", { package: "Seldaek/monolog", url: GITHUB_DIST }],
		["three segments", { package: "a/b/c", url: GITHUB_DIST }],
		["an empty vendor", { package: "/monolog", url: GITHUB_DIST }],
		["an empty package", { package: "monolog/", url: GITHUB_DIST }],
		["a dot-dot segment", { package: "../monolog", url: GITHUB_DIST }],
		["a missing name", { url: GITHUB_DIST }],
	])("with %s is refused as invalid_request", async (_, params) => {
		const upstream = servingZipAt(CODELOAD);

		const response = await proxyRequest(upstream, archivePath(params));

		expect(response.status).toBe(400);
		expect(response.headers.get("Diffpack-Proxy-Error")).toBe(
			"invalid_request",
		);
		expect(upstream.calls).toEqual([]);
	});
});
