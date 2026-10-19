import { errorResponse } from "./errors";

const VENDOR = "[a-z0-9]+(?:[_.-][a-z0-9]+)*";
const PACKAGE = "[a-z0-9]+(?:(?:[_.]|-{1,2})[a-z0-9]+)*";
const COMPOSER_NAME = new RegExp(`^${VENDOR}/${PACKAGE}$`);

export function isComposerPackageName(
	name: string | undefined,
): name is string {
	return name !== undefined && COMPOSER_NAME.test(name);
}

export function invalidPackageName(): Response {
	return errorResponse(
		"invalid_request",
		"The package name is not a valid Composer name.",
	);
}
