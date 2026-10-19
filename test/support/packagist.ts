export function p2UpstreamUrl(name: string): string {
	return `https://repo.packagist.org/p2/${name}.json`;
}

export function p2Listing(name: string, distUrls: string[]): string {
	const versions = distUrls.map(
		(url, index) =>
			`{"version":"1.0.${index}","dist":{"type":"zip","url":"${url}","shasum":""}}`,
	);
	return `{"packages":{"${name}":[${versions.join(",")}]},"minified":"composer/2.0"}`;
}
