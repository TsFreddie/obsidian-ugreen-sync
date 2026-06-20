import { Vault } from 'obsidian';
import {
	downloadRemoteFile,
	listRemoteFiles,
	prepareUgreenClient,
	trashRemoteFile,
	uploadRemoteFile,
} from './ugreen';
import {
	LocalFileMeta,
	RemoteFileMeta,
	SyncProgress,
	SyncResult,
	SyncStateEntry,
	UgreenSyncSettings,
} from './types';
import { debugLog } from './debug';
import { CONFLICTS_FOLDER } from './constants';

export async function runSync(
	vault: Vault,
	settings: UgreenSyncSettings,
	onProgress?: (progress: SyncProgress) => void,
): Promise<SyncResult> {
	await ensureNoUnresolvedConflicts(vault);
	const jobSettings: UgreenSyncSettings = {
		...settings,
		remoteBaseDir: settings.remoteBaseDir,
		syncState: { ...settings.syncState },
	};

	debugLog(jobSettings, 'sync start', {
		remoteBaseDir: jobSettings.remoteBaseDir,
		hasPreviousState: Object.keys(jobSettings.syncState).length > 0,
	});
	const client = await prepareUgreenClient(jobSettings);
	const localFiles = await listLocalFiles(vault, jobSettings);
	const remoteFiles = await listRemoteFiles(client, jobSettings);
	debugLog(jobSettings, 'sync indexes ready', {
		localFiles: localFiles.size,
		remoteFiles: remoteFiles.size,
	});
	const nextState: Record<string, SyncStateEntry> = { ...jobSettings.syncState };
	const sortedPaths = [...new Set([...localFiles.keys(), ...remoteFiles.keys()])].sort();
	onProgress?.({ completed: 0, total: sortedPaths.length });
	const result: SyncResult = {
		syncState: nextState,
		uploaded: 0,
		downloaded: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: 0,
	};

	for (const [index, path] of sortedPaths.entries()) {
		const local = localFiles.get(path);
		const remote = remoteFiles.get(path);
		const previous = jobSettings.syncState[path];

		try {
			if (local !== undefined && remote !== undefined) {
				debugLog(jobSettings, 'sync compare existing', { path, local, remote, previous });
				await syncExistingFile(vault, jobSettings, client, local, remote, previous, result);
				continue;
			}

			if (local !== undefined) {
				debugLog(jobSettings, 'sync local only', { path, local, previous });
				await syncLocalOnlyFile(vault, jobSettings, client, local, previous, result);
				continue;
			}

			if (remote !== undefined) {
				debugLog(jobSettings, 'sync remote only', { path, remote, previous });
				await syncRemoteOnlyFile(vault, jobSettings, client, remote, previous, result);
			}
		} finally {
			onProgress?.({ completed: index + 1, total: sortedPaths.length, path });
		}
	}

	debugLog(jobSettings, 'sync complete', { result });

	return result;
}

async function syncExistingFile(
	vault: Vault,
	settings: UgreenSyncSettings,
	client: Awaited<ReturnType<typeof prepareUgreenClient>>,
	local: LocalFileMeta,
	remote: RemoteFileMeta,
	previous: SyncStateEntry | undefined,
	result: SyncResult,
): Promise<void> {
	const localChanged = previous === undefined || hasLocalChanged(local, previous);
	const remoteChanged = previous === undefined || hasRemoteChanged(remote, previous);
	debugLog(settings, 'sync decision existing', {
		path: local.path,
		localChanged,
		remoteChanged,
		localMtime: local.mtime,
		remoteMtime: remote.mtime,
		previous,
	});

	if (!localChanged && !remoteChanged) {
		setSynced(result.syncState, local, remote);
		return;
	}

	if (localChanged && remoteChanged) {
		if (local.size === remote.size) {
			const localContent = await vault.adapter.readBinary(local.path);
			const remoteContent = await downloadRemoteFile(client, settings, remote.path);
			if (arrayBuffersEqual(localContent, remoteContent)) {
				debugLog(settings, 'sync decision same content keep both timestamps', { path: local.path });
				setSynced(result.syncState, local, remote);
				return;
			}
		}

		debugLog(settings, 'sync decision conflict download remote', { path: local.path });
		await createConflictCopy(vault, settings, local);
		result.conflicts += 1;
		await downloadAndRecord(vault, settings, client, remote, result);
		return;
	}

	if (localChanged) {
		debugLog(settings, 'sync decision upload local changed', { path: local.path });
		await uploadAndRecord(vault, settings, client, local, result);
		return;
	}

	debugLog(settings, 'sync decision download remote changed', { path: remote.path });
	await downloadAndRecord(vault, settings, client, remote, result);
}

async function syncLocalOnlyFile(
	vault: Vault,
	settings: UgreenSyncSettings,
	client: Awaited<ReturnType<typeof prepareUgreenClient>>,
	local: LocalFileMeta,
	previous: SyncStateEntry | undefined,
	result: SyncResult,
): Promise<void> {
	if (previous !== undefined && !hasLocalChanged(local, previous)) {
		debugLog(settings, 'local delete start', { path: local.path, previous });
		await vault.adapter.remove(local.path);
		debugLog(settings, 'local delete complete', { path: local.path });
		delete result.syncState[local.path];
		result.deletedLocal += 1;
		return;
	}

	await uploadAndRecord(vault, settings, client, local, result);
}

async function syncRemoteOnlyFile(
	vault: Vault,
	settings: UgreenSyncSettings,
	client: Awaited<ReturnType<typeof prepareUgreenClient>>,
	remote: RemoteFileMeta,
	previous: SyncStateEntry | undefined,
	result: SyncResult,
): Promise<void> {
	if (previous !== undefined && !hasRemoteChanged(remote, previous)) {
		debugLog(settings, 'remote delete start', { path: remote.path, previous });
		await trashRemoteFile(client, settings, remote.path);
		debugLog(settings, 'remote delete complete', { path: remote.path });
		delete result.syncState[remote.path];
		result.deletedRemote += 1;
		return;
	}

	await downloadAndRecord(vault, settings, client, remote, result);
}

async function uploadAndRecord(
	vault: Vault,
	settings: UgreenSyncSettings,
	client: Awaited<ReturnType<typeof prepareUgreenClient>>,
	local: LocalFileMeta,
	result: SyncResult,
): Promise<void> {
	debugLog(settings, 'local read start', { path: local.path, size: local.size, mtime: local.mtime });
	const content = await vault.adapter.readBinary(local.path);
	debugLog(settings, 'local read complete', { path: local.path, size: content.byteLength });
	const remote = await uploadRemoteFile(client, settings, local.path, content, local.mtime);
	setSynced(result.syncState, local, remote);
	result.uploaded += 1;
}

async function downloadAndRecord(
	vault: Vault,
	settings: UgreenSyncSettings,
	client: Awaited<ReturnType<typeof prepareUgreenClient>>,
	remote: RemoteFileMeta,
	result: SyncResult,
): Promise<void> {
	await ensureLocalParent(vault, settings, remote.path);
	const content = await downloadRemoteFile(client, settings, remote.path);
	await writeDownloadedContentAndRecord(vault, settings, remote, content, result);
}

async function writeDownloadedContentAndRecord(
	vault: Vault,
	settings: UgreenSyncSettings,
	remote: RemoteFileMeta,
	content: ArrayBuffer,
	result: SyncResult,
): Promise<void> {
	const options = { mtime: remote.mtime };
	debugLog(settings, 'local write start', { path: remote.path, size: content.byteLength, options });
	await vault.adapter.writeBinary(remote.path, content, options);
	debugLog(settings, 'local write complete', { path: remote.path, size: content.byteLength, options });
	setSynced(result.syncState, localFromRemote(remote), remote);
	result.downloaded += 1;
}

async function listLocalFiles(
	vault: Vault,
	settings: UgreenSyncSettings,
): Promise<Map<string, LocalFileMeta>> {
	const files = new Map<string, LocalFileMeta>();
	for (const file of vault.getFiles()) {
		const meta = {
			path: file.path,
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
		debugLog(settings, 'local file found', meta);
		files.set(file.path, meta);
	}
	return files;
}

async function ensureLocalParent(vault: Vault, settings: UgreenSyncSettings, path: string): Promise<void> {
	const parts = path.split('/');
	parts.pop();
	let current = '';
	for (const part of parts) {
		current = current === '' ? part : `${current}/${part}`;
		if (!(await vault.adapter.exists(current))) {
			debugLog(settings, 'local folder create', { path: current });
			await vault.adapter.mkdir(current);
		}
	}
}

async function createConflictCopy(vault: Vault, settings: UgreenSyncSettings, local: LocalFileMeta): Promise<void> {
	const conflictPath = getConflictPath(local.path);
	await ensureLocalParent(vault, settings, conflictPath);
	const content = await vault.adapter.readBinary(local.path);
	const options = { mtime: local.mtime };
	debugLog(settings, 'local conflict copy start', { path: local.path, conflictPath, options });
	await vault.adapter.writeBinary(conflictPath, content, options);
	debugLog(settings, 'local conflict copy complete', { path: local.path, conflictPath, options });
}

function getConflictPath(path: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const conflictPath = `${CONFLICTS_FOLDER}/${path}`;
	const lastSlash = conflictPath.lastIndexOf('/');
	const directory = lastSlash === -1 ? '' : conflictPath.slice(0, lastSlash + 1);
	const filename = lastSlash === -1 ? conflictPath : conflictPath.slice(lastSlash + 1);
	const lastDot = filename.lastIndexOf('.');
	if (lastDot <= 0) {
		return `${directory}${filename}.conflict-${timestamp}`;
	}
	return `${directory}${filename.slice(0, lastDot)}.conflict-${timestamp}${filename.slice(lastDot)}`;
}

async function ensureNoUnresolvedConflicts(vault: Vault): Promise<void> {
	if (await hasConflictFiles(vault, CONFLICTS_FOLDER)) {
		throw new Error('Unresolved sync conflicts exist in .conflicts. Resolve them before syncing again.');
	}
}

async function hasConflictFiles(vault: Vault, folderPath: string): Promise<boolean> {
	if (!(await vault.adapter.exists(folderPath))) {
		return false;
	}

	const listed = await vault.adapter.list(folderPath);
	if (listed.files.length > 0) {
		return true;
	}

	for (const folder of listed.folders) {
		if (await hasConflictFiles(vault, folder)) {
			return true;
		}
	}

	return false;
}

function hasLocalChanged(local: LocalFileMeta, previous: SyncStateEntry): boolean {
	return local.size !== previous.size || local.mtime !== previous.localMtime;
}

function hasRemoteChanged(remote: RemoteFileMeta, previous: SyncStateEntry): boolean {
	return (
		remote.size !== previous.size ||
		remote.etag !== previous.etag ||
		remote.mtime !== previous.remoteMtime
	);
}

function arrayBuffersEqual(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}

	const leftBytes = new Uint8Array(left);
	const rightBytes = new Uint8Array(right);
	for (let index = 0; index < leftBytes.length; index += 1) {
		if (leftBytes[index] !== rightBytes[index]) {
			return false;
		}
	}

	return true;
}

function setSynced(
	state: Record<string, SyncStateEntry>,
	local: LocalFileMeta,
	remote: RemoteFileMeta,
): void {
	state[local.path] = {
		localMtime: local.mtime,
		remoteMtime: remote.mtime,
		size: local.size,
		etag: remote.etag,
	};
}

function localFromRemote(remote: RemoteFileMeta): LocalFileMeta {
	return {
		path: remote.path,
		mtime: remote.mtime,
		size: remote.size,
	};
}
