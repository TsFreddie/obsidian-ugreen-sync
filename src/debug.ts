import { UgreenSyncSettings } from './types';

export function debugLog(
	settings: UgreenSyncSettings,
	operation: string,
	details: Record<string, unknown> = {},
): void {
	if (!settings.debugLogging) {
		return;
	}

	// eslint-disable-next-line obsidianmd/rule-custom-message -- User-enabled diagnostics for debugging sync behavior.
	console.log(`[UGREEN Sync] ${operation}`, details);
}
