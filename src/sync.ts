import { Vault } from 'obsidian';
import {
	clearRemoteFolderCache,
	downloadRemoteFile,
	getRemoteBasePath,
	isRemoteDirectoryEmpty,
	listRemoteFiles,
	prepareUgreenClient,
	toRemotePath,
	trashRemoteFile,
	trashRemoteFolder,
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
import { t } from './i18n';

const MAX_SYNC_CONCURRENCY = 4;

export async function runSync(
	vault: Vault,
	settings: UgreenSyncSettings,
	onProgress?: (progress: SyncProgress) => void,
): Promise<SyncResult> {
	await ensureNoUnresolvedConflicts(vault);
	clearRemoteFolderCache();
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
	const trashedRemotePaths: string[] = [];
	const deletedLocalPaths: string[] = [];

	const operationsByDepth = groupOperationsByDepth(sortedPaths, localFiles, remoteFiles, jobSettings);

	const dirLocks = new Map<string, Promise<void>>();

	const depths = [...operationsByDepth.keys()].sort((a, b) => a - b);
	let completedCount = 0;

	for (const depth of depths) {
		const ops = operationsByDepth.get(depth)!;
		await runWithConcurrencyLimit(ops, MAX_SYNC_CONCURRENCY, async (op) => {
			const { path, local, remote, previous } = op;
			try {
				if (local !== undefined && remote !== undefined) {
					debugLog(jobSettings, 'sync compare existing', { path, local, remote, previous });
					await syncExistingFile(vault, jobSettings, client, local, remote, previous, result, dirLocks);
				} else if (local !== undefined) {
					debugLog(jobSettings, 'sync local only', { path, local, previous });
					await syncLocalOnlyFile(vault, jobSettings, client, local, previous, result, deletedLocalPaths);
				} else if (remote !== undefined) {
					debugLog(jobSettings, 'sync remote only', { path, remote, previous });
					await syncRemoteOnlyFile(vault, jobSettings, client, remote, previous, result, trashedRemotePaths, dirLocks);
				}
			} finally {
				completedCount += 1;
				onProgress?.({ completed: completedCount, total: sortedPaths.length, path });
			}
		});
	}

	if (deletedLocalPaths.length > 0 || trashedRemotePaths.length > 0) {
		const remoteDeletedDirSet = extractParentDirSet(trashedRemotePaths);

		if (trashedRemotePaths.length > 0) {
			await cleanupEmptyRemoteFolders(client, jobSettings, trashedRemotePaths);
		}

		if (deletedLocalPaths.length > 0) {
			await cleanupEmptyLocalFolders(vault, jobSettings, deletedLocalPaths, remoteDeletedDirSet);
		}
	}

	for (const path of Object.keys(nextState)) {
		if (!localFiles.has(path) && !remoteFiles.has(path)) {
			debugLog(jobSettings, 'sync state cleanup stale entry', { path });
			delete nextState[path];
		}
	}

	debugLog(jobSettings, 'sync complete', { result });

	return result;
}

interface SyncOperation {
	path: string;
	local: LocalFileMeta | undefined;
	remote: RemoteFileMeta | undefined;
	previous: SyncStateEntry | undefined;
}

function groupOperationsByDepth(
	sortedPaths: string[],
	localFiles: Map<string, LocalFileMeta>,
	remoteFiles: Map<string, RemoteFileMeta>,
	settings: UgreenSyncSettings,
): Map<number, SyncOperation[]> {
	const byDepth = new Map<number, SyncOperation[]>();
	for (const path of sortedPaths) {
		const depth = path.split('/').length - 1;
		if (!byDepth.has(depth)) {
			byDepth.set(depth, []);
		}
		byDepth.get(depth)!.push({
			path,
			local: localFiles.get(path),
			remote: remoteFiles.get(path),
			previous: settings.syncState[path],
		});
	}
	return byDepth;
}

async function runWithConcurrencyLimit<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let index = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const current = index;
			if (current >= items.length) {
				break;
			}
			index = current + 1;
			await fn(items[current]!);
		}
	};

	const workerCount = Math.min(limit, items.length);
	const workers = Array.from({ length: workerCount }, () => worker());
	await Promise.all(workers);
}

async function syncExistingFile(
	vault: Vault,
	settings: UgreenSyncSettings,
	client: Awaited<ReturnType<typeof prepareUgreenClient>>,
	local: LocalFileMeta,
	remote: RemoteFileMeta,
	previous: SyncStateEntry | undefined,
	result: SyncResult,
	dirLocks: Map<string, Promise<void>>,
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
		await createConflictCopy(vault, settings, local, dirLocks);
		result.conflicts += 1;
		await downloadAndRecord(vault, settings, client, remote, result, dirLocks);
		return;
	}

	if (localChanged) {
		debugLog(settings, 'sync decision upload local changed', { path: local.path });
		await uploadAndRecord(vault, settings, client, local, result);
		return;
	}

	debugLog(settings, 'sync decision download remote changed', { path: remote.path });
	await downloadAndRecord(vault, settings, client, remote, result, dirLocks);
}

async function syncLocalOnlyFile(
	vault: Vault,
	settings: UgreenSyncSettings,
	client: Awaited<ReturnType<typeof prepareUgreenClient>>,
	local: LocalFileMeta,
	previous: SyncStateEntry | undefined,
	result: SyncResult,
	deletedLocalPaths: string[],
): Promise<void> {
	if (previous !== undefined && !hasLocalChanged(local, previous)) {
		debugLog(settings, 'local delete start', { path: local.path, previous });
		await vault.adapter.remove(local.path);
		debugLog(settings, 'local delete complete', { path: local.path });
		delete result.syncState[local.path];
		result.deletedLocal += 1;
		deletedLocalPaths.push(local.path);
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
	trashedRemotePaths: string[],
	dirLocks: Map<string, Promise<void>>,
): Promise<void> {
	if (previous !== undefined && !hasRemoteChanged(remote, previous)) {
		debugLog(settings, 'remote delete start', { path: remote.path, previous });
		await trashRemoteFile(client, settings, remote.path);
		debugLog(settings, 'remote delete complete', { path: remote.path });
		delete result.syncState[remote.path];
		result.deletedRemote += 1;
		trashedRemotePaths.push(remote.path);
		return;
	}

	await downloadAndRecord(vault, settings, client, remote, result, dirLocks);
}

function extractParentDirSet(filePaths: string[]): Set<string> {
	const dirs = new Set<string>();
	for (const filePath of filePaths) {
		const parts = filePath.split('/');
		parts.pop();
		let dirPath = parts.join('/');
		while (dirPath !== '') {
			dirs.add(dirPath);
			const parentParts = dirPath.split('/');
			parentParts.pop();
			dirPath = parentParts.join('/');
		}
	}
	return dirs;
}

async function cleanupEmptyLocalFolders(
	vault: Vault,
	settings: UgreenSyncSettings,
	deletedFilePaths: string[],
	otherSideDirSet: Set<string>,
): Promise<void> {
	const candidates = new Set<string>();

	for (const filePath of deletedFilePaths) {
		const parts = filePath.split('/');
		parts.pop();
		let dirPath = parts.join('/');
		while (dirPath !== '') {
			candidates.add(dirPath);
			const parentParts = dirPath.split('/');
			parentParts.pop();
			dirPath = parentParts.join('/');
		}
	}

	const sorted = [...candidates].sort(
		(a, b) => b.split('/').length - a.split('/').length,
	);

	for (const dir of sorted) {
		if (otherSideDirSet.has(dir)) {
			continue;
		}

		if (!(await vault.adapter.exists(dir))) {
			continue;
		}

		const listed = await vault.adapter.list(dir);
		if (listed.files.length === 0 && listed.folders.length === 0) {
			debugLog(settings, 'local empty folder cleanup', { path: dir });
			await vault.adapter.rmdir(dir, false);
		}
	}
}

async function cleanupEmptyRemoteFolders(
	client: Awaited<ReturnType<typeof prepareUgreenClient>>,
	settings: UgreenSyncSettings,
	trashedFilePaths: string[],
): Promise<void> {
	const basePath = getRemoteBasePath(settings);
	const candidates = new Set<string>();

	for (const filePath of trashedFilePaths) {
		const parts = filePath.split('/');
		parts.pop();
		let dirPath = parts.join('/');
		while (dirPath !== '') {
			candidates.add(dirPath);
			const parentParts = dirPath.split('/');
			parentParts.pop();
			dirPath = parentParts.join('/');
		}
	}

	const sorted = [...candidates].sort(
		(a, b) => b.split('/').length - a.split('/').length,
	);

	for (const dir of sorted) {
		const remoteDirPath = toRemotePath(settings, dir);
		if (remoteDirPath === basePath) {
			continue;
		}

		if (await isRemoteDirectoryEmpty(client, remoteDirPath)) {
			debugLog(settings, 'remote empty folder cleanup', {
				path: remoteDirPath,
			});
			await trashRemoteFolder(client, settings, dir);
		}
	}
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
	dirLocks: Map<string, Promise<void>>,
): Promise<void> {
	await ensureLocalParent(vault, settings, remote.path, dirLocks);
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

async function ensureLocalParent(
	vault: Vault,
	settings: UgreenSyncSettings,
	path: string,
	dirLocks: Map<string, Promise<void>>,
): Promise<void> {
	const parts = path.split('/');
	parts.pop();
	let current = '';
	for (const part of parts) {
		current = current === '' ? part : `${current}/${part}`;
		const existing = dirLocks.get(current);
		if (existing !== undefined) {
			await existing;
			continue;
		}
		const lock = (async () => {
			if (!(await vault.adapter.exists(current))) {
				debugLog(settings, 'local folder create', { path: current });
				await vault.adapter.mkdir(current);
			}
		})();
		dirLocks.set(current, lock);
		await lock;
	}
}

async function createConflictCopy(vault: Vault, settings: UgreenSyncSettings, local: LocalFileMeta, dirLocks: Map<string, Promise<void>>): Promise<void> {
	const conflictPath = getConflictPath(local.path);
	await ensureLocalParent(vault, settings, conflictPath, dirLocks);
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
		throw new Error(t('error.unresolvedConflicts'));
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

export function hasRemoteChanged(remote: RemoteFileMeta, previous: SyncStateEntry): boolean {
	// NOTE: remote mtime has second-level precision (see direntToRemoteFile).
	// Two modifications of the same file within the same second will share the
	// same mtime and will not be detected as a change by this comparison.
	// This is inherent to the Ugreen NAS API; the size check mitigates this
	// for same-second modifications that change file size.
	return (
		remote.size !== previous.size ||
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
