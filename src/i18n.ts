import en from './locale/en.json';
import zh from './locale/zh.json';

type LocaleData = typeof en;

/* eslint-disable @typescript-eslint/no-unsafe-assignment -- JSON imports have implicit any type */
const locales: Record<string, LocaleData> = {
	en,
	zh,
};
/* eslint-enable @typescript-eslint/no-unsafe-assignment */

export const SUPPORTED_LOCALES = { en: 'English', zh: '中文' } as const;

export type LocaleKey = keyof typeof SUPPORTED_LOCALES;

let currentLocale: LocaleKey = 'en';

export function setLocale(locale: LocaleKey): void {
	currentLocale = locale;
}

export function getLocale(): LocaleKey {
	return currentLocale;
}

export function detectLocale(appLang?: string | null): LocaleKey {
	if (appLang === 'zh') {
		return 'zh';
	}
	return 'en';
}

export function t(key: string, params?: Record<string, string | number>): string {
	const localeData = (locales[currentLocale] ?? locales.en) as Record<string, unknown>;
	const raw = getNestedValue(localeData, key)
		?? getNestedValue(locales.en as Record<string, unknown>, key)
		?? key;
	if (params) {
		return raw.replace(/\{\{(\w+)\}\}/g, (_match, paramKey: string) =>
			String(params[paramKey] ?? `{{${paramKey}}}`),
		);
	}
	return raw;
}

function getNestedValue(
	obj: Record<string, unknown>,
	key: string,
): string | undefined {
	const parts = key.split('.');
	let current: unknown = obj;
	for (const part of parts) {
		if (current == null || typeof current !== 'object') {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return typeof current === 'string' ? current : undefined;
}