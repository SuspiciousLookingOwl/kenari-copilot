/**
 * Localization helper.
 *
 * This build ships English only: `l10n` returns the key (the English text)
 * unchanged. The indirection is kept so user-facing strings stay in one
 * place and a future translation layer can be added without touching call
 * sites.
 */

/**
 * Get the localized string for the given key.
 */
export function l10n(key: string): string {
	return key;
}

/**
 * Format a localized template containing {0}, {1}, ... placeholders.
 */
export function l10nFormat(template: string, ...args: Array<string | number>): string {
	return template.replace(/\{(\d+)\}/g, (match, index) => {
		const value = args[Number(index)];
		return value === undefined ? match : String(value);
	});
}
