import type { SessionContainer } from 'ug-file';

export interface UgreenSyncSettings {
	url: string;
	ugreenLinkId: string;
	username: string;
	session?: SessionContainer;
	remoteBaseDir: string;
	autoSyncEnabled: boolean;
	autoSyncIntervalMinutes: number;
	autoSyncManualBlockReason?: AutoSyncManualBlockReason;
	hasPendingChanges: boolean;
	lastLocalChangeAt: number;
	debugLogging: boolean;
	syncState: Record<string, SyncStateEntry>;
	lastSyncAt: number;
	lastSyncRemoteDir: string;
}

export type AutoSyncManualBlockReason =
	| 'keep-both-conflict-resolution'
	| 'nas-dir-changed';

export interface SyncStateEntry {
	localMtime: number;
	remoteMtime: number;
	size: number;
	etag: string;
}

export const DEFAULT_SETTINGS: UgreenSyncSettings = {
	url: '',
	ugreenLinkId: '',
	username: '',
	session: undefined,
	remoteBaseDir: '',
	autoSyncEnabled: false,
	autoSyncIntervalMinutes: 15,
	autoSyncManualBlockReason: undefined,
	hasPendingChanges: false,
	lastLocalChangeAt: 0,
	debugLogging: false,
	syncState: {},
	lastSyncAt: 0,
	lastSyncRemoteDir: '',
};

export interface LocalFileMeta {
	path: string;
	mtime: number;
	size: number;
}

export interface RemoteFileMeta {
	path: string;
	mtime: number;
	size: number;
	etag: string;
}

export interface SyncResult {
	syncState: Record<string, SyncStateEntry>;
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
}

export interface SyncProgress {
	completed: number;
	total: number;
	path?: string;
}
