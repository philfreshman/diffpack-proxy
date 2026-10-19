#!/usr/bin/env bash
set -euo pipefail

readonly ALLOWED_ORIGIN="https://diffpack.io"
readonly FOREIGN_ORIGIN="https://example.com"
readonly PACKAGE="monolog/monolog"
readonly LISTED_ARCHIVE="https://api.github.com/repos/Seldaek/monolog/zipball/d7059e4c691d05ea1222b5124bed0f961be46e15"
readonly UNLISTED_ARCHIVE="https://api.github.com/repos/Seldaek/monolog/zipball/0000000000000000000000000000000000000000"
readonly REQUEST_TIMEOUT_SECONDS=30

usage() {
	printf 'Usage: %s <origin>\n' "$(basename "$0")" >&2
	printf 'Example: %s https://diffpack-proxy.example.workers.dev\n' "$(basename "$0")" >&2
	exit 2
}

[[ $# -eq 1 && -n $1 ]] || usage
readonly PROXY_ORIGIN="${1%/}"

work_dir="$(mktemp -d)"
readonly work_dir
trap 'rm -rf "$work_dir"' EXIT
readonly HEADERS_FILE="$work_dir/headers"
readonly BODY_FILE="$work_dir/body"

failures=0

pass() {
	printf 'PASS  %s\n' "$1"
}

fail() {
	printf 'FAIL  %s: %s\n' "$1" "$2"
	failures=$((failures + 1))
}

request() {
	local method="$1" path="$2" origin="${3:-}"
	local curl_args=(--silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS"
		--dump-header "$HEADERS_FILE" --output "$BODY_FILE" --write-out '%{http_code}')
	[[ $method == HEAD ]] && curl_args+=(--head)
	[[ -n $origin ]] && curl_args+=(--header "Origin: $origin")
	: >"$HEADERS_FILE"
	: >"$BODY_FILE"
	curl "${curl_args[@]}" "$PROXY_ORIGIN$path" || true
}

header_value() {
	local wanted
	wanted="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
	tr -d '\r' <"$HEADERS_FILE" | awk -v wanted="$wanted" '
		{ separator = index($0, ":") }
		separator > 0 && tolower(substr($0, 1, separator - 1)) == wanted {
			value = substr($0, separator + 1)
			sub(/^[ \t]+/, "", value)
			print value
			exit
		}'
}

unexpected_status() {
	local error_code
	error_code="$(header_value Diffpack-Proxy-Error)"
	printf 'got status %s%s' "$1" "${error_code:+ ($error_code)}"
}

body_matches() {
	grep -Eq "$1" "$BODY_FILE"
}

url_encode() {
	local text="$1" encoded="" character i
	for ((i = 0; i < ${#text}; i++)); do
		character="${text:i:1}"
		case "$character" in
		[A-Za-z0-9._~-]) encoded+="$character" ;;
		*) encoded+="$(printf '%%%02X' "'$character")" ;;
		esac
	done
	printf '%s' "$encoded"
}

archive_path() {
	printf '/v1/composer/archive?package=%s&url=%s' "$(url_encode "$PACKAGE")" "$(url_encode "$1")"
}

check_health() {
	local name="GET /v1/health answers 200" status
	status="$(request GET /v1/health)"
	if [[ $status != 200 ]]; then
		fail "$name" "$(unexpected_status "$status")"
	else
		pass "$name"
	fi
}

check_status_is_open() {
	local name="GET /v1/status answers 200 with open: true" status
	status="$(request GET /v1/status)"
	if [[ $status != 200 ]]; then
		fail "$name" "$(unexpected_status "$status")"
	elif ! body_matches '"open"[[:space:]]*:[[:space:]]*true'; then
		fail "$name" "body was $(cat "$BODY_FILE")"
	else
		pass "$name"
	fi
}

check_p2_allows_diffpack() {
	local name="GET p2 for $PACKAGE answers 200 with CORS for $ALLOWED_ORIGIN" status allowed_origin
	status="$(request GET "/v1/composer/p2/$PACKAGE.json" "$ALLOWED_ORIGIN")"
	allowed_origin="$(header_value Access-Control-Allow-Origin)"
	if [[ $status != 200 ]]; then
		fail "$name" "$(unexpected_status "$status")"
	elif [[ $allowed_origin != "$ALLOWED_ORIGIN" ]]; then
		fail "$name" "Access-Control-Allow-Origin was '${allowed_origin}'"
	else
		pass "$name"
	fi
}

check_go_search_answers() {
	local name="GET Go search for chi answers 200 with items" status
	status="$(request GET "/v1/go/search?q=chi" "$ALLOWED_ORIGIN")"
	if [[ $status != 200 ]]; then
		fail "$name" "$(unexpected_status "$status")"
	elif ! body_matches '"items"[[:space:]]*:[[:space:]]*\['; then
		fail "$name" "body did not list items"
	else
		pass "$name"
	fi
}

check_listed_archive_is_served() {
	local name="HEAD archive for $PACKAGE 3.12.1 answers 200 with application/zip" status content_type
	status="$(request HEAD "$(archive_path "$LISTED_ARCHIVE")" "$ALLOWED_ORIGIN")"
	content_type="$(header_value Content-Type)"
	if [[ $status != 200 ]]; then
		fail "$name" "$(unexpected_status "$status")"
	elif [[ $content_type != application/zip* ]]; then
		fail "$name" "Content-Type was '${content_type}'"
	else
		pass "$name"
	fi
}

check_foreign_origin_is_refused() {
	local name="GET p2 from Origin $FOREIGN_ORIGIN answers 403 origin_not_allowed" status error_code
	status="$(request GET "/v1/composer/p2/$PACKAGE.json" "$FOREIGN_ORIGIN")"
	error_code="$(header_value Diffpack-Proxy-Error)"
	if [[ $status != 403 ]]; then
		fail "$name" "$(unexpected_status "$status")"
	elif [[ $error_code != origin_not_allowed ]]; then
		fail "$name" "Diffpack-Proxy-Error was '${error_code}'"
	else
		pass "$name"
	fi
}

check_unlisted_archive_is_refused() {
	local name="GET an archive Packagist does not list answers 403 archive_not_listed" status error_code
	status="$(request GET "$(archive_path "$UNLISTED_ARCHIVE")" "$ALLOWED_ORIGIN")"
	error_code="$(header_value Diffpack-Proxy-Error)"
	if [[ $status != 403 ]]; then
		fail "$name" "$(unexpected_status "$status")"
	elif [[ $error_code != archive_not_listed ]]; then
		fail "$name" "Diffpack-Proxy-Error was '${error_code}'"
	else
		pass "$name"
	fi
}

printf 'Smoke test against %s\n' "$PROXY_ORIGIN"
check_health
check_status_is_open
check_p2_allows_diffpack
check_go_search_answers
check_listed_archive_is_served
check_foreign_origin_is_refused
check_unlisted_archive_is_refused

if ((failures > 0)); then
	printf '%d check(s) failed.\n' "$failures"
	exit 1
fi
printf 'All checks passed.\n'
