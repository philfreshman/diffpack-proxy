const VENDOR = "[a-z0-9]+(?:[_.-][a-z0-9]+)*";
const PACKAGE = "[a-z0-9]+(?:(?:[_.]|-{1,2})[a-z0-9]+)*";
const COMPOSER_NAME = new RegExp(`^${VENDOR}/${PACKAGE}$`);

export function isComposerPackageName(name: string): boolean {
	return COMPOSER_NAME.test(name);
}
