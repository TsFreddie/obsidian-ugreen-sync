import { requestUrl } from 'obsidian';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { UgosApiError, UgosClient, UgosHttpError } from 'ug-file';
import type { ConflictAction, UgosDirent } from 'ug-file';
import { UgreenSyncSettings, RemoteFileMeta } from './types';
import { debugLog } from './debug';

const UGOS_FOLDER_ALREADY_EXISTS = 1327;
const FORBIDDEN_REQUEST_HEADERS = new Set([
	'connection',
	'content-length',
	'cookie',
	'cookie2',
	'host',
	'keep-alive',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'upgrade-insecure-requests',
]);

const STATUS_TEXTS: Record<number, string> = {
	200: 'OK',
	201: 'Created',
	204: 'No Content',
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	409: 'Conflict',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
	502: 'Bad Gateway',
	503: 'Service Unavailable',
	504: 'Gateway Timeout',
};

class FetchHeaders {
	private headers: Record<string, string>;

	constructor(headers: Record<string, string>) {
		this.headers = Object.fromEntries(
			Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
		);
	}

	get(name: string): string | null {
		return this.headers[name.toLowerCase()] ?? null;
	}
}

class FetchResponse {
	readonly status: number;
	readonly headers: FetchHeaders;
	private response: RequestUrlResponse;

	constructor(response: RequestUrlResponse) {
		this.status = response.status;
		this.headers = new FetchHeaders(response.headers);
		this.response = response;
	}

	get ok(): boolean {
		return this.status >= 200 && this.status < 300;
	}

	get statusText(): string {
		return STATUS_TEXTS[this.status] ?? '';
	}

	async text(): Promise<string> {
		return this.response.text;
	}

	async json(): Promise<unknown> {
		return this.response.json;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return this.response.arrayBuffer;
	}
}

export function createUgreenClient(settings: UgreenSyncSettings): UgosClient {
	validateSettings(settings);

	if (settings.url.trim() !== '') {
		return new UgosClient({
			url: normalizeUrl(settings.url),
			username: settings.username,
			password: settings.password,
			fetch: fetchAdapter,
		});
	}

	return new UgosClient({
		uglinkid: settings.ugreenLinkId,
		username: settings.username,
		password: settings.password,
		fetch: fetchAdapter,
	});
}

export async function prepareUgreenClient(settings: UgreenSyncSettings): Promise<UgosClient> {
	debugLog(settings, 'remote client prepare', {
		mode: settings.url.trim() !== '' ? 'url' : 'ugreenlink',
		remoteBaseDir: settings.remoteBaseDir,
	});
	const client = createUgreenClient(settings);
	await client.login();
	const basePath = getRemoteBasePath(settings);
	debugLog(settings, 'remote base exists check', { path: basePath });
	if (!(await client.exists(basePath))) {
		await mkdirIfMissing(client, settings, basePath);
	}
	return client;
}

export function getRemoteBasePath(settings: UgreenSyncSettings): string {
	const baseDir = settings.remoteBaseDir.trim();
	if (baseDir === '') {
		throw new Error('NAS sync directory is required.');
	}
	return `/${baseDir.replace(/^\/+|\/+$/g, '')}`;
}

export function toRemotePath(settings: UgreenSyncSettings, localPath: string): string {
	const basePath = getRemoteBasePath(settings);
	const cleanLocalPath = localPath.replace(/^\/+|\/+$/g, '');
	return cleanLocalPath === '' ? basePath : `${basePath}/${cleanLocalPath}`;
}

export async function listRemoteFiles(
	client: UgosClient,
	settings: UgreenSyncSettings,
): Promise<Map<string, RemoteFileMeta>> {
	const basePath = getRemoteBasePath(settings);
	debugLog(settings, 'remote list start', { path: basePath });
	const files = new Map<string, RemoteFileMeta>();
	await listRemoteFilesInDirectory(client, settings, basePath, basePath, files);
	debugLog(settings, 'remote list complete', { path: basePath, files: files.size });
	return files;
}

export async function uploadRemoteFile(
	client: UgosClient,
	settings: UgreenSyncSettings,
	localPath: string,
	content: ArrayBuffer,
	localMtime: number,
): Promise<RemoteFileMeta> {
	const remotePath = toRemotePath(settings, localPath);
	const options = {
		actionType: 'overwrite' as ConflictAction,
		changeTime: toUgosTimestamp(localMtime),
		resume: false,
	};
	debugLog(settings, 'remote upload start', {
		localPath,
		remotePath,
		size: content.byteLength,
		localMtime,
		options,
	});
	await ensureRemoteParent(client, settings, remotePath);
	await client.upload(remotePath, new Uint8Array(content), options);
	const stat = await client.stat(remotePath);
	const remote = direntToRemoteFile(stat, getRemoteBasePath(settings));
	if (remote.size !== content.byteLength) {
		throw new Error(
			`Remote upload verification failed for ${localPath}: expected ${content.byteLength} bytes, got ${remote.size} bytes.`,
		);
	}
	debugLog(settings, 'remote upload complete', { localPath, remotePath, remote });
	return remote;
}

export async function downloadRemoteFile(
	client: UgosClient,
	settings: UgreenSyncSettings,
	localPath: string,
): Promise<ArrayBuffer> {
	const remotePath = toRemotePath(settings, localPath);
	debugLog(settings, 'remote download start', { localPath, remotePath });
	const bytes = await client.readFile(remotePath);
	debugLog(settings, 'remote download complete', {
		localPath,
		remotePath,
		size: bytes.byteLength,
	});
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function trashRemoteFile(
	client: UgosClient,
	settings: UgreenSyncSettings,
	localPath: string,
): Promise<void> {
	const remotePath = toRemotePath(settings, localPath);
	debugLog(settings, 'remote trash', { localPath, remotePath });
	await client.trash(remotePath);
}

export function formatUgreenError(error: unknown): string {
	if (error instanceof UgosApiError) {
		return joinErrorParts([
			`UGREEN API error ${error.code}`,
			error.message,
			getResponseSummary(error.response),
		]);
	}
	if (error instanceof UgosHttpError) {
		return joinErrorParts([
			`HTTP ${error.status} ${error.statusText}`,
			getTextSummary(error.body),
		]);
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export function logUgreenError(context: string, error: unknown): void {
	console.error(`[UGREEN Sync] ${context}: ${formatUgreenError(error)}`, getErrorDetails(error));
}

function getErrorDetails(error: unknown): unknown {
	if (error instanceof UgosApiError) {
		return {
			name: error.name,
			message: error.message,
			code: error.code,
			response: error.response,
			stack: error.stack,
		};
	}
	if (error instanceof UgosHttpError) {
		return {
			name: error.name,
			message: error.message,
			status: error.status,
			statusText: error.statusText,
			body: parseJsonIfPossible(error.body),
			stack: error.stack,
		};
	}
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}
	return error;
}

function joinErrorParts(parts: Array<string | undefined>): string {
	return [...new Set(parts.filter((part): part is string => part !== undefined && part !== ''))].join(': ');
}

function getResponseSummary(response: unknown): string | undefined {
	if (!isRecord(response)) {
		return getTextSummary(response);
	}

	const message = getStringProperty(response, 'msg') ?? getStringProperty(response, 'message');
	const status = getStringProperty(response, 'status');
	const code = getNumberProperty(response, 'code');
	const data = response.data;
	const dataSummary = typeof data === 'string' ? data : undefined;

	return joinErrorParts([
		message,
		status !== undefined ? `status ${status}` : undefined,
		code !== undefined ? `code ${code}` : undefined,
		dataSummary,
	]);
}

function getTextSummary(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	if (trimmed === '') {
		return undefined;
	}

	const parsed = parseJsonIfPossible(trimmed);
	if (parsed !== trimmed) {
		const summary = getResponseSummary(parsed);
		if (summary !== undefined && summary !== '') {
			return summary;
		}
	}

	return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
}

function parseJsonIfPossible(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getStringProperty(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function getNumberProperty(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' ? value : undefined;
}

function toUgosTimestamp(timestamp: number): number {
	return timestamp > 9999999999 ? Math.floor(timestamp / 1000) : Math.floor(timestamp);
}

async function listRemoteFilesInDirectory(
	client: UgosClient,
	settings: UgreenSyncSettings,
	basePath: string,
	directoryPath: string,
	files: Map<string, RemoteFileMeta>,
): Promise<void> {
	let page = 1;
	const limit = 2000;

	while (true) {
		debugLog(settings, 'remote list page', { path: directoryPath, page, limit });
		const entries = await client.list(directoryPath, { page, limit });
		debugLog(settings, 'remote list page result', {
			path: directoryPath,
			page,
			entries: entries.length,
		});
		for (const entry of entries) {
			if (entry.path === basePath || entry.path === `${basePath}/`) {
				continue;
			}
			if (entry.isDirectory()) {
				await listRemoteFilesInDirectory(client, settings, basePath, entry.path, files);
			} else if (entry.isFile()) {
				const file = direntToRemoteFile(entry, basePath);
				debugLog(settings, 'remote file found', { file });
				files.set(file.path, file);
			}
		}

		if (entries.length < limit) {
			break;
		}
		page += 1;
	}
}

async function ensureRemoteParent(
	client: UgosClient,
	settings: UgreenSyncSettings,
	remotePath: string,
): Promise<void> {
	const lastSlash = remotePath.lastIndexOf('/');
	if (lastSlash <= 0) {
		return;
	}
	await mkdirIfMissing(client, settings, remotePath.slice(0, lastSlash));
}


async function mkdirIfMissing(
	client: UgosClient,
	settings: UgreenSyncSettings,
	remotePath: string,
): Promise<void> {
	debugLog(settings, 'remote folder exists check', { path: remotePath });
	if (await client.exists(remotePath)) {
		debugLog(settings, 'remote folder exists', { path: remotePath });
		return;
	}

	const options = { recursive: true };
	debugLog(settings, 'remote folder create', { path: remotePath, options });
	try {
		await client.mkdir(remotePath, options.recursive);
		debugLog(settings, 'remote folder create complete', { path: remotePath, options });
	} catch (error) {
		if (
			error instanceof UgosApiError &&
			error.code === UGOS_FOLDER_ALREADY_EXISTS &&
			(await client.exists(remotePath))
		) {
			debugLog(settings, 'remote folder create already exists', { path: remotePath, options });
			return;
		}
		throw error;
	}
}

function direntToRemoteFile(entry: UgosDirent, basePath: string): RemoteFileMeta {
	const prefix = `${basePath}/`;
	if (!entry.path.startsWith(prefix)) {
		throw new Error(`Remote path is outside sync directory: ${entry.path}`);
	}

	return {
		path: entry.path.slice(prefix.length),
		mtime: entry.mtime * 1000,
		size: entry.size,
		etag: `${entry.mtime}_${entry.name}`,
	};
}

function validateSettings(settings: UgreenSyncSettings): void {
	if (settings.url.trim() === '' && settings.ugreenLinkId.trim() === '') {
		throw new Error('NAS address or UGREENlink ID is required.');
	}
	if (settings.username.trim() === '') {
		throw new Error('Username is required.');
	}
	if (settings.password === '') {
		throw new Error('Password is required.');
	}
	if (settings.remoteBaseDir.trim() === '') {
		throw new Error('NAS sync directory is required.');
	}
}

function normalizeUrl(value: string): string {
	const trimmed = value.trim().replace(/\/+$/g, '');
	return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

const fetchAdapter: typeof fetch = async (input, init): Promise<Response> => {
	let body: string | ArrayBuffer | undefined;
	let contentType: string | undefined;
	const headers = headersToRecord(init?.headers);

	if (init?.body instanceof FormData) {
		const serialized = await serializeFormData(init.body);
		body = serialized.body;
		contentType = serialized.contentType;
		delete headers['content-type'];
		delete headers['Content-Type'];
	} else if (ArrayBuffer.isView(init?.body)) {
		body = init.body.buffer.slice(
			init.body.byteOffset,
			init.body.byteOffset + init.body.byteLength,
		);
	} else if (init?.body instanceof ArrayBuffer) {
		body = init.body;
	} else if (typeof init?.body === 'string') {
		body = init.body;
	} else if (init?.body != null) {
		throw new Error('Unsupported request body type.');
	}

	contentType = contentType ?? headers['content-type'] ?? headers['Content-Type'];
	delete headers['content-type'];
	delete headers['Content-Type'];

	const request: RequestUrlParam = {
		url: inputToUrl(input),
		method: init?.method,
		headers,
		body,
		throw: false,
	};
	if (contentType !== undefined) {
		request.contentType = contentType;
	}

	let response: RequestUrlResponse;
	try {
		response = await requestUrl(request);
	} catch (error) {
		console.error('[UGREEN Sync] transport request failed', {
			method: request.method ?? 'GET',
			url: sanitizeUrl(request.url),
			contentType: request.contentType,
			headers: summarizeHeaders(request.headers),
			body: summarizeBody(request.body),
			error: getErrorDetails(error),
		});
		throw error;
	}

	return new FetchResponse(response) as unknown as Response;
};

function sanitizeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		for (const key of parsed.searchParams.keys()) {
			if (/token|password|secret|key/i.test(key)) {
				parsed.searchParams.set(key, '<redacted>');
			}
		}
		return parsed.toString();
	} catch {
		return url;
	}
}

function summarizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	if (headers === undefined) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [
			key,
			/token|password|secret|key/i.test(key) ? '<redacted>' : `${value.length} chars`,
		]),
	);
}

function summarizeBody(body: string | ArrayBuffer | undefined): string {
	if (body === undefined) {
		return 'none';
	}
	if (typeof body === 'string') {
		return `${body.length} chars`;
	}
	return `${body.byteLength} bytes`;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
	if (headers === undefined) {
		return {};
	}
	if (headers instanceof Headers) {
		const record: Record<string, string> = {};
		headers.forEach((value, key) => {
			record[key] = value;
		});
		return filterRequestHeaders(record);
	}
	if (Array.isArray(headers)) {
		return filterRequestHeaders(Object.fromEntries(headers));
	}
	return filterRequestHeaders({ ...headers });
}

function filterRequestHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(([key]) => !FORBIDDEN_REQUEST_HEADERS.has(key.toLowerCase())),
	);
}

function inputToUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') {
		return input;
	}
	if (input instanceof URL) {
		return input.href;
	}
	return input.url;
}

async function serializeFormData(
	formData: FormData,
): Promise<{ body: ArrayBuffer; contentType: string }> {
	const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
	const parts: Uint8Array[] = [];
	const encoder = new TextEncoder();

	const entries: [string, FormDataEntryValue][] = [];
	formData.forEach((value, name) => {
		entries.push([name, value]);
	});

	for (const [name, value] of entries) {
		let content: Uint8Array;
		let filename = '';
		let fileType = '';

		if (value instanceof Blob) {
			filename = 'name' in value && typeof value.name === 'string' ? value.name : '';
			fileType = value.type || 'application/octet-stream';
			content = new Uint8Array(await value.arrayBuffer());
		} else {
			content = encoder.encode(value);
		}

		let header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
		if (filename !== '') {
			header += `; filename="${filename}"`;
		}
		if (fileType !== '') {
			header += `\r\nContent-Type: ${fileType}`;
		}
		header += '\r\n\r\n';

		parts.push(encoder.encode(header));
		parts.push(content);
		parts.push(encoder.encode('\r\n'));
	}

	parts.push(encoder.encode(`--${boundary}--\r\n`));

	const size = parts.reduce((sum, part) => sum + part.length, 0);
	const body = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.length;
	}

	return {
		body: body.buffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}
