import type { Relay } from "./edge-cache";
import { errorResponse } from "./errors";

export const GO_SEARCH_PATH = "/v1/go/search";
const QUERY_PARAMETER = "q";
const LONGEST_QUERY = 100;
const RESULTS_PER_SEARCH = 25;
const GO_SEARCH_HEADERS = {
	"Content-Type": "application/json",
	"Cache-Control": "public, max-age=3600",
};

export async function relayGoSearch(
	relay: Relay,
	searchParams: URLSearchParams,
): Promise<Response> {
	const query = singleQuery(searchParams);
	if (query === undefined) {
		return invalidQuery();
	}
	return relay(goSearchSourceUrl(query), GO_SEARCH_HEADERS);
}

function singleQuery(searchParams: URLSearchParams): string | undefined {
	const [query, ...extra] = searchParams.getAll(QUERY_PARAMETER);
	if (query === undefined || extra.length > 0) {
		return undefined;
	}
	return isAcceptedLength(query) ? query : undefined;
}

function isAcceptedLength(query: string): boolean {
	return query.length > 0 && query.length <= LONGEST_QUERY;
}

function goSearchSourceUrl(query: string): string {
	const params = new URLSearchParams({
		q: query,
		limit: String(RESULTS_PER_SEARCH),
	});
	return `https://pkg.go.dev/v1/search?${params}`;
}

function invalidQuery(): Response {
	return errorResponse(
		"invalid_request",
		`The search text must be given once and be 1 to ${LONGEST_QUERY} characters long.`,
	);
}
