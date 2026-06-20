import type { SessionContainer } from 'ug-file';

export interface UgreenSyncSettings {
	url: string;
	ugreenLinkId: string;
	username: string;
	session?: SessionContainer;
	remoteBaseDir: string;
	debugLogging: boolean;
	syncState: Record<string, SyncStateEntry>;
	lastSyncAt: number;
}

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
	debugLogging: false,
	syncState: {},
	lastSyncAt: 0,
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
