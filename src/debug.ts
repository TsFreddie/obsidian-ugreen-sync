import { UgreenSyncSettings } from './types';

export function debugLog(
	settings: UgreenSyncSettings,
	operation: string,
	details: Record<string, unknown> = {},
): void {
	if (!settings.debugLogging) {
		return;
	}

	console.debug(`[UGREEN Sync] ${operation}`, details);
}
