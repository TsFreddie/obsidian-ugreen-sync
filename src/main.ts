import {
	Menu,
	Notice,
	Plugin,
	setIcon,
	type App,
	type IconName,
	type TAbstractFile,
} from 'obsidian';
import { openUgreenLoginModal } from './login';
import { UgreenSyncSettingTab } from './settings';
import {
	DEFAULT_SETTINGS,
	SyncProgress,
	SyncResult,
	UgreenSyncSettings,
} from './types';
import { runSync } from './sync';
import {
	formatUgreenError,
	getRemoteBaseDirAccessError,
	hasValidUgreenSession,
	logUgreenError,
} from './ugreen';
import {
	getConflictFiles,
	hasUnresolvedConflicts,
	openConflictPrompt,
	openConflictResolver,
} from './conflicts';
import { debugLog } from './debug';
import { CONFLICTS_FOLDER } from './constants';

const AUTO_SYNC_DISABLED_NOTICE =
	'To prevent data corruption while changing settings. Auto-sync has been turned off';
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 15;
const AUTO_SYNC_INTERVAL_OPTIONS = [1, 5, 15, 30, 60] as const;
const LOCAL_CHANGE_SAVE_DEBOUNCE_MS = 500;

export default class UgreenSyncPlugin extends Plugin {
	settings!: UgreenSyncSettings;
	private settingTab?: UgreenSyncSettingTab;
	private statusBarItem?: HTMLElement;
	private statusIconEl?: HTMLElement;
	private statusIconName?: IconName;
	private statusProgressEl?: HTMLElement;
	private latestStatus: SyncStatus = { label: 'Checking', kind: 'running' };
	private syncInProgress = false;
	private syncPromise?: Promise<boolean>;
	private autoSyncIntervalId?: number;
	private autoSyncQueued = false;
	private pendingChangeSaveTimeout?: number;

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('ugreen-sync-status-bar');
		this.statusBarItem.setAttribute('role', 'button');
		this.statusBarItem.setAttribute('tabindex', '0');
		this.registerDomEvent(this.statusBarItem, 'click', (event) => {
			this.showStatusMenu(event);
		});
		this.registerDomEvent(this.statusBarItem, 'keydown', (event) => {
			if (event.key !== 'Enter' && event.key !== ' ') {
				return;
			}

			event.preventDefault();
			this.showStatusMenuAtStatusBar();
		});
		this.setStatus({ label: 'Checking', kind: 'running' });
		void this.checkLoginOnLaunch();
		void this.updateConflictStatus();
		this.app.workspace.onLayoutReady(() =>
			this.registerVaultChangeHandlers(),
		);
		this.registerAutoSyncLifecycleHandlers();
		this.configureAutoSyncInterval();
		this.register(() => {
			this.clearAutoSyncInterval();
			this.clearPendingChangeSaveTimeout();
		});

		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			checkCallback: (checking) => {
				if (!this.isSignedIn() || !this.hasRemoteBaseDir()) {
					return false;
				}

				if (!checking) {
					void this.syncNow();
				}

				return true;
			},
		});

		this.settingTab = new UgreenSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
	}

	onunload() {}

	async syncNow(options: SyncNowOptions = {}): Promise<boolean> {
		if (this.syncPromise !== undefined) {
			return this.syncPromise;
		}

		const syncPromise = this.runSyncNow(options);
		this.syncPromise = syncPromise;
		try {
			return await syncPromise;
		} finally {
			if (this.syncPromise === syncPromise) {
				this.syncPromise = undefined;
			}
		}
	}

	private async runSyncNow(options: SyncNowOptions): Promise<boolean> {
		const showInfoNotices = options.showInfoNotices ?? true;
		const showSuccessNotice = options.showSuccessNotice ?? true;
		const promptOnConflicts = options.promptOnConflicts ?? true;
		const allowLoginPrompt = options.allowLoginPrompt ?? true;
		const clearAutoSyncManualBlock =
			options.clearAutoSyncManualBlock ?? true;
		if (!this.isSignedIn()) {
			this.setStatus({ label: 'Logged out', kind: 'warning' });
			if (showInfoNotices) {
				new Notice('Sign in to UGREEN NAS before syncing.');
			}
			return false;
		}
		if (!this.hasRemoteBaseDir()) {
			this.setStatus({ label: 'No NAS directory', kind: 'warning' });
			if (showInfoNotices) {
				new Notice('Set a NAS sync directory before syncing.');
			}
			return false;
		}

		if (!(await this.ensureSignedIn(allowLoginPrompt))) {
			this.setStatus({ label: 'Logged out', kind: 'warning' });
			return false;
		}

		if (await hasUnresolvedConflicts(this.app.vault)) {
			await this.updateConflictStatus();
			if (promptOnConflicts) {
				openConflictPrompt(this.app, () => {
					void this.resolveConflicts();
				});
			}
			return false;
		}

		const remoteBaseDir = this.settings.remoteBaseDir;
		try {
			if (clearAutoSyncManualBlock) {
				await this.clearAutoSyncManualBlock();
			}
			this.syncInProgress = true;
			this.setStatus({ label: 'Syncing', kind: 'running' });

			const result = await runSync(
				this.app.vault,
				this.settings,
				(progress) => {
					this.setStatus({
						label: 'Syncing',
						kind: 'running',
						progress: getSyncProgressPercent(progress),
					});
				},
			);
			if (this.settings.remoteBaseDir !== remoteBaseDir) {
				this.setStatus({
					label: 'NAS directory changed',
					kind: 'warning',
				});
				if (showInfoNotices) {
					new Notice(
						'NAS sync directory changed during sync. Sync history was not updated.',
						8000,
					);
				}
				return false;
			}

			this.settings.syncState = result.syncState;
			this.settings.lastSyncAt = Date.now();
			this.updatePendingChangesFromSyncState(result.syncState);
			await this.saveSettings();

			this.setStatus(formatSyncStatusMessage(result));
			if (showSuccessNotice) {
				new Notice(
					formatSyncSuccessNotice(result, this.app.vault.getName()),
				);
			}
			return true;
		} catch (error) {
			const errorMessage = formatUgreenError(error);
			logUgreenError('sync failed', error);
			this.setStatus({
				label: 'Failed',
				details: [errorMessage],
				kind: 'error',
			});
			new Notice(`UGREEN sync failed: ${errorMessage}`, 8000);
			return false;
		} finally {
			this.syncInProgress = false;
			void this.updateConflictStatus();
		}
	}

	async resolveConflicts() {
		if (!this.isSignedIn()) {
			this.setStatus({ label: 'Logged out', kind: 'warning' });
			new Notice('Sign in to UGREEN NAS before resolving conflicts.');
			return;
		}
		if (!this.hasRemoteBaseDir()) {
			this.setStatus({ label: 'No NAS directory', kind: 'warning' });
			new Notice('Set a NAS sync directory before resolving conflicts.');
			return;
		}

		await openConflictResolver(this.app, (result) => {
			void this.afterConflictResolve(result);
		});
	}

	private async afterConflictResolve(result: {
		keptBoth: boolean;
		syncAfterResolve: boolean;
	}): Promise<void> {
		if (result.keptBoth) {
			await this.blockAutoSyncUntilManualSync();
		}

		await this.updateConflictStatus();
		if (result.syncAfterResolve) {
			void this.syncNow({ promptOnConflicts: false });
		}
	}

	async signIn(): Promise<boolean> {
		const result = await openUgreenLoginModal(this.app, this.settings);
		if (result === undefined) {
			return false;
		}

		this.settings.url = result.url;
		this.settings.ugreenLinkId = result.ugreenLinkId;
		this.settings.username = result.username;
		this.settings.session = result.session;
		this.disableAutoSyncForSafety();
		await this.saveSettings();
		this.setSignedInIdleStatus('Logged in');
		void this.checkRemoteBaseDirAccessAfterLogin();
		void this.updateConflictStatus();
		return true;
	}

	async logout() {
		this.settings.session = undefined;
		this.disableAutoSyncForSafety();
		await this.saveSettings();
		this.setStatus({ label: 'Logged out', kind: 'warning' });
		void this.updateConflictStatus();
		new Notice('Logged out of UGREEN NAS.');
	}

	async testConnection() {
		await this.signIn();
	}

	private async checkLoginOnLaunch(): Promise<void> {
		debugLog(this.settings, 'startup session check start', {
			hasSession: this.settings.session !== undefined,
		});
		if (this.settings.session === undefined) {
			debugLog(this.settings, 'startup session check skipped', {
				reason: 'missing session',
			});
			this.disableAutoSyncForSafety();
			await this.saveSettings();
			this.setStatus({ label: 'Logged out', kind: 'warning' });
			void this.updateConflictStatus();
			return;
		}

		try {
			if (await hasValidUgreenSession(this.settings)) {
				debugLog(this.settings, 'startup session check success');
				this.setSignedInIdleStatus('Logged in');
				void this.updateConflictStatus();
				void this.runAutoSync('launch');
				return;
			}

			debugLog(this.settings, 'startup session check expired');
			this.settings.session = undefined;
			this.disableAutoSyncForSafety();
			await this.saveSettings();
			this.setStatus({ label: 'Logged out', kind: 'warning' });
		} catch (error) {
			debugLog(this.settings, 'startup session check error', {
				message: formatUgreenError(error),
			});
			logUgreenError('startup session check failed', error);
			this.setStatus({ label: 'Check failed', kind: 'error' });
		} finally {
			void this.updateConflictStatus();
		}
	}

	private async ensureSignedIn(allowLoginPrompt: boolean): Promise<boolean> {
		if (this.settings.session !== undefined) {
			try {
				if (await hasValidUgreenSession(this.settings)) {
					return true;
				}
			} catch (error) {
				logUgreenError('session check failed', error);
				new Notice(
					`UGREEN NAS session check failed: ${formatUgreenError(error)}`,
					8000,
				);
				return false;
			}

			this.settings.session = undefined;
			this.disableAutoSyncForSafety();
			await this.saveSettings();
		}

		return allowLoginPrompt ? this.signIn() : false;
	}

	private isSignedIn(): boolean {
		return this.settings.session !== undefined;
	}

	private hasRemoteBaseDir(): boolean {
		return this.settings.remoteBaseDir.trim() !== '';
	}

	async setRemoteBaseDir(remoteBaseDir: string): Promise<void> {
		if (this.settings.remoteBaseDir === remoteBaseDir) {
			return;
		}

		this.settings.remoteBaseDir = remoteBaseDir;
		this.settings.syncState = {};
		this.settings.lastSyncAt = 0;
		this.settings.autoSyncManualBlockReason = undefined;
		this.settings.hasPendingChanges = false;
		this.settings.lastLocalChangeAt = 0;
		this.disableAutoSyncForSafety();
		await this.saveSettings();
		this.configureAutoSyncInterval();
	}

	async setAutoSyncEnabled(enabled: boolean): Promise<void> {
		if (enabled && (!this.isSignedIn() || !this.hasRemoteBaseDir())) {
			new Notice(
				'Sign in and set a NAS sync directory before enabling auto-sync.',
			);
			enabled = false;
		}

		this.settings.autoSyncEnabled = enabled;
		this.settings.autoSyncIntervalMinutes =
			normalizeAutoSyncIntervalMinutes(
				this.settings.autoSyncIntervalMinutes,
			);
		if (!enabled) {
			this.settings.autoSyncManualBlockReason = undefined;
		}
		await this.saveSettings();
		this.configureAutoSyncInterval();
		if (enabled && this.hasAutoSyncManualBlock()) {
			this.setAutoSyncManualBlockStatus();
		}
	}

	async setAutoSyncIntervalMinutes(minutes: number): Promise<void> {
		this.settings.autoSyncIntervalMinutes =
			normalizeAutoSyncIntervalMinutes(minutes);
		await this.saveSettings();
		this.configureAutoSyncInterval();
	}

	private async checkRemoteBaseDirAccessAfterLogin(): Promise<void> {
		if (!this.hasRemoteBaseDir()) {
			return;
		}

		try {
			const accessError = await getRemoteBaseDirAccessError(
				this.settings,
			);
			if (accessError !== undefined) {
				new Notice(accessError, 8000);
			}
		} catch (error) {
			logUgreenError('remote base directory access check failed', error);
			new Notice(
				`Could not check NAS sync directory access: ${formatUgreenError(error)}`,
				8000,
			);
		}
	}

	async loadSettings() {
		const savedData = ((await this.loadData()) ??
			{}) as Partial<UgreenSyncSettings>;
		const savedSettings = Object.fromEntries(
			Object.entries({
				url: savedData.url,
				ugreenLinkId: savedData.ugreenLinkId,
				username: savedData.username,
				session: savedData.session,
				remoteBaseDir: savedData.remoteBaseDir,
				autoSyncEnabled: savedData.autoSyncEnabled,
				autoSyncIntervalMinutes: savedData.autoSyncIntervalMinutes,
				autoSyncManualBlockReason: savedData.autoSyncManualBlockReason,
				hasPendingChanges: savedData.hasPendingChanges,
				lastLocalChangeAt: savedData.lastLocalChangeAt,
				debugLogging: savedData.debugLogging,
				syncState: savedData.syncState,
				lastSyncAt: savedData.lastSyncAt,
			}).filter(([, value]) => value !== undefined),
		) as Partial<UgreenSyncSettings>;
		if (savedSettings.autoSyncIntervalMinutes !== undefined) {
			savedSettings.autoSyncIntervalMinutes =
				normalizeAutoSyncIntervalMinutes(
					savedSettings.autoSyncIntervalMinutes,
				);
		}

		this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
	}

	async saveSettings() {
		await this.saveData({
			url: this.settings.url,
			ugreenLinkId: this.settings.ugreenLinkId,
			username: this.settings.username,
			session: this.settings.session,
			remoteBaseDir: this.settings.remoteBaseDir,
			autoSyncEnabled: this.settings.autoSyncEnabled,
			autoSyncIntervalMinutes: this.settings.autoSyncIntervalMinutes,
			autoSyncManualBlockReason: this.settings.autoSyncManualBlockReason,
			hasPendingChanges: this.settings.hasPendingChanges,
			lastLocalChangeAt: this.settings.lastLocalChangeAt,
			debugLogging: this.settings.debugLogging,
			syncState: this.settings.syncState,
			lastSyncAt: this.settings.lastSyncAt,
		});
	}

	private registerVaultChangeHandlers(): void {
		const handleChange = (file: TAbstractFile, oldPath?: string) => {
			this.markLocalChanged(file, oldPath);
			void this.updateConflictStatus();
		};

		this.registerEvent(this.app.vault.on('create', handleChange));
		this.registerEvent(this.app.vault.on('modify', handleChange));
		this.registerEvent(this.app.vault.on('delete', handleChange));
		this.registerEvent(this.app.vault.on('rename', handleChange));
	}

	private registerAutoSyncLifecycleHandlers(): void {
		this.registerEvent(
			this.app.workspace.on('quit', (tasks) => {
				if (!this.isSignedIn() || !this.hasRemoteBaseDir()) {
					return;
				}
				debugLog(this.settings, 'quit sync trigger');
				tasks.addPromise(
					this.syncNow({
						showInfoNotices: false,
						showSuccessNotice: false,
						allowLoginPrompt: false,
						promptOnConflicts: false,
						clearAutoSyncManualBlock: false,
					}),
				);
			}),
		);
		this.registerDomEvent(activeDocument, 'visibilitychange', () => {
			if (
				activeDocument.visibilityState === 'hidden' &&
				this.settings.hasPendingChanges
			) {
				void this.runAutoSync('visibility change', {
					requirePendingChanges: true,
				});
			}
		});
		this.registerDomEvent(activeWindow, 'pagehide', () => {
			if (!this.settings.hasPendingChanges) {
				return;
			}
			void this.syncNow({
				showInfoNotices: false,
				showSuccessNotice: false,
				allowLoginPrompt: false,
				promptOnConflicts: false,
				clearAutoSyncManualBlock: false,
			});
		});
	}

	private configureAutoSyncInterval(): void {
		this.clearAutoSyncInterval();
		if (!this.settings.autoSyncEnabled) {
			return;
		}

		this.autoSyncIntervalId = window.setInterval(() => {
			void this.runAutoSync('interval');
		}, getAutoSyncIntervalMs(this.settings.autoSyncIntervalMinutes));
	}

	private clearAutoSyncInterval(): void {
		if (this.autoSyncIntervalId === undefined) {
			return;
		}

		window.clearInterval(this.autoSyncIntervalId);
		this.autoSyncIntervalId = undefined;
	}

	private async runAutoSync(
		source: AutoSyncSource,
		options: AutoSyncOptions = {},
	): Promise<boolean> {
		if (!this.settings.autoSyncEnabled || this.autoSyncQueued) {
			return false;
		}
		if (this.hasAutoSyncManualBlock()) {
			this.setAutoSyncManualBlockStatus();
			return false;
		}
		if (
			options.requirePendingChanges === true &&
			!this.settings.hasPendingChanges
		) {
			return false;
		}
		if (!this.isSignedIn() || !this.hasRemoteBaseDir()) {
			return false;
		}

		this.autoSyncQueued = true;
		try {
			debugLog(this.settings, 'auto sync trigger', { source });
			return await this.syncNow({
				allowLoginPrompt: false,
				clearAutoSyncManualBlock: false,
				promptOnConflicts: false,
				showInfoNotices: false,
				showSuccessNotice: false,
			});
		} finally {
			this.autoSyncQueued = false;
		}
	}

	private markLocalChanged(file: TAbstractFile, oldPath?: string): void {
		if (
			this.syncInProgress ||
			!shouldTrackLocalChange(file.path, oldPath)
		) {
			return;
		}

		this.settings.hasPendingChanges = true;
		this.settings.lastLocalChangeAt = Date.now();
		if (this.hasAutoSyncManualBlock()) {
			this.setAutoSyncManualBlockStatus();
			this.schedulePendingChangeSave();
			return;
		}
		this.setStatus({
			label: 'Changed',
			details: ['Local changes not synced'],
			kind: 'warning',
		});
		this.schedulePendingChangeSave();
	}

	private schedulePendingChangeSave(): void {
		this.clearPendingChangeSaveTimeout();
		this.pendingChangeSaveTimeout = window.setTimeout(() => {
			this.pendingChangeSaveTimeout = undefined;
			void this.saveSettings();
		}, LOCAL_CHANGE_SAVE_DEBOUNCE_MS);
	}

	private clearPendingChangeSaveTimeout(): void {
		if (this.pendingChangeSaveTimeout === undefined) {
			return;
		}

		window.clearTimeout(this.pendingChangeSaveTimeout);
		this.pendingChangeSaveTimeout = undefined;
	}

	private updatePendingChangesFromSyncState(
		syncState: Record<string, UgreenSyncSettings['syncState'][string]>,
	): void {
		const localFiles = new Map(
			this.app.vault
				.getFiles()
				.filter((file) => shouldTrackLocalChange(file.path))
				.map((file) => [file.path, file]),
		);

		for (const file of localFiles.values()) {
			const entry = syncState[file.path];
			if (
				entry === undefined ||
				entry.size !== file.stat.size ||
				entry.localMtime !== file.stat.mtime
			) {
				this.settings.hasPendingChanges = true;
				this.settings.lastLocalChangeAt = Date.now();
				return;
			}
		}

		for (const path of Object.keys(syncState)) {
			if (shouldTrackLocalChange(path) && !localFiles.has(path)) {
				this.settings.hasPendingChanges = true;
				this.settings.lastLocalChangeAt = Date.now();
				return;
			}
		}

		this.settings.hasPendingChanges = false;
		this.settings.lastLocalChangeAt = 0;
	}

	private disableAutoSyncForSafety(): void {
		if (!this.settings.autoSyncEnabled) {
			return;
		}

		this.settings.autoSyncEnabled = false;
		this.settings.autoSyncManualBlockReason = undefined;
		this.clearAutoSyncInterval();
		this.settingTab?.refreshAutoSyncControls();
		new Notice(AUTO_SYNC_DISABLED_NOTICE, 8000);
	}

	private setSignedInIdleStatus(label: string): void {
		if (this.hasAutoSyncManualBlock()) {
			this.setAutoSyncManualBlockStatus();
			return;
		}

		if (this.settings.hasPendingChanges) {
			this.setStatus({
				label: 'Changed',
				details: ['Local changes not synced'],
				kind: 'warning',
			});
			return;
		}

		this.setStatus({ label, kind: 'success' });
	}

	private setStatus(status: SyncStatus) {
		this.latestStatus = status;
		if (this.statusBarItem === undefined) {
			return;
		}
		const statusText = formatStatusText(status);
		const statusClass = this.getStatusClass(status);
		const statusIcon = this.getStatusIcon(status);

		this.statusBarItem.toggleClass(
			'ugreen-sync-status-running',
			statusClass === 'ugreen-sync-status-running',
		);
		this.statusBarItem.toggleClass(
			'ugreen-sync-status-warning',
			statusClass === 'ugreen-sync-status-warning',
		);
		this.statusBarItem.toggleClass(
			'ugreen-sync-status-success',
			statusClass === 'ugreen-sync-status-success',
		);
		this.statusBarItem.toggleClass(
			'ugreen-sync-conflict-status',
			statusClass === 'ugreen-sync-conflict-status',
		);
		this.updateStatusIcon(statusIcon, status.progress);
		this.statusBarItem.setAttribute(
			'aria-label',
			`${statusText}. Open UGREEN sync menu`,
		);
		this.statusBarItem.setAttribute('title', statusText);
	}

	private updateStatusIcon(
		iconName: IconName,
		progress: number | undefined,
	): void {
		if (this.statusBarItem === undefined) {
			return;
		}

		if (
			this.statusIconEl === undefined ||
			this.statusIconName !== iconName
		) {
			this.statusBarItem.empty();
			this.statusProgressEl = undefined;
			this.statusIconEl = activeDocument.createElement('span');
			this.statusIconEl.addClass('ugreen-sync-status-icon');
			setIcon(this.statusIconEl, iconName);
			this.statusBarItem.append(this.statusIconEl);
			this.statusIconName = iconName;
		}

		if (progress !== undefined) {
			if (this.statusProgressEl === undefined) {
				this.statusProgressEl = activeDocument.createElement('span');
				this.statusProgressEl.addClass('ugreen-sync-status-progress');
				this.statusIconEl.append(this.statusProgressEl);
			}

			this.statusProgressEl.setText(progress.toString());
			return;
		}

		if (this.statusProgressEl !== undefined) {
			this.statusProgressEl.remove();
			this.statusProgressEl = undefined;
		}
	}

	private showStatusMenu(event: MouseEvent): void {
		const menu = new Menu();

		menu.setUseNativeMenu(false);
		menu.addItem((item) => {
			item.setTitle(this.createStatusMenuTitle())
				.setIsLabel(true)
				.setSection('ugreen-sync-status');
		});
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle('Sync now')
				.setIcon('sync')
				.setDisabled(
					!this.isSignedIn() ||
						!this.hasRemoteBaseDir() ||
						this.syncInProgress,
				)
				.onClick(() => {
					void this.syncNow();
				});
		});
		if (isConflictStatus(this.latestStatus)) {
			menu.addItem((item) => {
				item.setTitle('Resolve conflicts')
					.setIcon('git-pull-request')
					.onClick(() => {
						void this.resolveConflicts();
					});
			});
		}
		menu.addItem((item) => {
			item.setTitle('Settings')
				.setIcon('settings')
				.onClick(() => {
					this.openSettings();
				});
		});

		menu.showAtMouseEvent(event);
	}

	private createStatusMenuTitle(): DocumentFragment {
		const fragment = activeDocument.createDocumentFragment();
		const statusEl = activeDocument.createElement('div');
		statusEl.addClass('ugreen-sync-menu-status');

		const bannerEl = activeDocument.createElement('div');
		bannerEl.addClass('ugreen-sync-menu-status-banner');
		bannerEl.setText('UGREEN NAS Sync');
		statusEl.append(bannerEl);

		const headingEl = activeDocument.createElement('div');
		headingEl.addClass('ugreen-sync-menu-status-heading');
		headingEl.setText('Sync status');
		statusEl.append(headingEl);

		for (const row of getStatusRows(this.latestStatus)) {
			const rowEl = activeDocument.createElement('div');
			rowEl.addClass('ugreen-sync-menu-status-row');
			rowEl.setText(row);
			statusEl.append(rowEl);
		}

		fragment.append(statusEl);
		return fragment;
	}

	private getStatusIcon(status: SyncStatus): IconName {
		if (status.kind === 'running') {
			return 'refresh-cw';
		}
		if (status.kind === 'error') {
			return 'alert-triangle';
		}
		if (status.kind === 'blocked') {
			return 'pause-circle';
		}
		if (status.kind === 'warning') {
			return 'alert-circle';
		}
		if (status.kind === 'success') {
			return 'check-circle';
		}

		return 'sync';
	}

	private getStatusClass(status: SyncStatus): string {
		if (status.kind === 'running') {
			return 'ugreen-sync-status-running';
		}
		if (status.kind === 'error') {
			return 'ugreen-sync-conflict-status';
		}
		if (status.kind === 'warning' || status.kind === 'blocked') {
			return 'ugreen-sync-status-warning';
		}

		return 'ugreen-sync-status-success';
	}

	private showStatusMenuAtStatusBar(): void {
		const rect = this.statusBarItem?.getBoundingClientRect();
		if (rect === undefined) {
			return;
		}

		this.showStatusMenu(
			new MouseEvent('click', {
				clientX: rect.left,
				clientY: rect.top,
				view: activeWindow,
			}),
		);
	}

	private openSettings(): void {
		const setting = (this.app as AppWithSettings).setting;
		if (setting === undefined) {
			new Notice('Could not open UGREEN sync settings.');
			return;
		}

		setting.open();
		setting.openTabById(this.manifest.id);
	}

	private async updateConflictStatus() {
		if (this.syncInProgress) {
			return;
		}

		if (!this.isSignedIn() || !this.hasRemoteBaseDir()) {
			this.statusBarItem?.removeClass('ugreen-sync-conflict-status');
			return;
		}

		const conflictCount = (await getConflictFiles(this.app.vault)).length;
		const conflictStatus = createConflictStatus(conflictCount);
		if (conflictCount > 0) {
			this.setStatus(conflictStatus);
		} else if (this.hasAutoSyncManualBlock()) {
			this.setAutoSyncManualBlockStatus();
		} else if (isConflictStatus(this.latestStatus)) {
			this.setSignedInIdleStatus('Ready');
		} else {
			this.statusBarItem?.removeClass('ugreen-sync-conflict-status');
		}
	}

	private async blockAutoSyncUntilManualSync(): Promise<void> {
		if (!this.settings.autoSyncEnabled) {
			return;
		}

		this.settings.autoSyncManualBlockReason =
			'keep-both-conflict-resolution';
		await this.saveSettings();
		this.setAutoSyncManualBlockStatus();
	}

	private async clearAutoSyncManualBlock(): Promise<void> {
		if (!this.hasAutoSyncManualBlock()) {
			return;
		}

		this.settings.autoSyncManualBlockReason = undefined;
		await this.saveSettings();
	}

	private hasAutoSyncManualBlock(): boolean {
		return (
			this.settings.autoSyncEnabled &&
			this.settings.autoSyncManualBlockReason !== undefined
		);
	}

	private setAutoSyncManualBlockStatus(): void {
		this.setStatus({
			label: 'Manual sync required',
			details: ['Auto-sync paused after keep both conflict resolution'],
			kind: 'blocked',
		});
	}
}

type SyncStatusKind = 'running' | 'warning' | 'success' | 'error' | 'blocked';

type AutoSyncSource = 'launch' | 'quit' | 'visibility change' | 'interval';

interface AutoSyncOptions {
	requirePendingChanges?: boolean;
}

interface SyncNowOptions {
	allowLoginPrompt?: boolean;
	clearAutoSyncManualBlock?: boolean;
	promptOnConflicts?: boolean;
	showInfoNotices?: boolean;
	showSuccessNotice?: boolean;
}

interface SyncStatus {
	label: string;
	details?: string[];
	kind: SyncStatusKind;
	progress?: number;
	conflictCount?: number;
}

type AppWithSettings = App & {
	setting?: {
		open(): void;
		openTabById(id: string): void;
	};
};

function formatStatusText(status: SyncStatus): string {
	const label = formatStatusLabel(status);
	if (status.details === undefined || status.details.length === 0) {
		return label;
	}

	return `${label}: ${status.details.join(', ')}.`;
}

function getStatusRows(status: SyncStatus): string[] {
	const label = formatStatusLabel(status);
	if (status.details === undefined || status.details.length === 0) {
		return [label];
	}
	if (status.label === 'Synced') {
		return status.details;
	}

	return [label, ...status.details];
}

function formatStatusLabel(status: SyncStatus): string {
	if (status.progress === undefined) {
		return status.label;
	}

	return `${status.label} ${status.progress}%`;
}

function createConflictStatus(conflictCount: number): SyncStatus {
	return {
		label: formatConflictStatusLabel(conflictCount),
		kind: 'error',
		conflictCount,
	};
}

function isConflictStatus(status: SyncStatus): boolean {
	return status.kind === 'error' && status.conflictCount !== undefined;
}

function formatConflictStatusLabel(count: number): string {
	return `${count} ${count === 1 ? 'conflict' : 'conflicts'}`;
}

function getSyncProgressPercent(progress: SyncProgress): number {
	if (progress.total <= 0) {
		return 100;
	}

	return Math.min(
		100,
		Math.max(0, Math.round((progress.completed / progress.total) * 100)),
	);
}

function formatSyncStatusMessage(result: SyncResult): SyncStatus {
	const stats = [
		formatSyncStat(result.uploaded, 'uploaded'),
		formatSyncStat(result.downloaded, 'downloaded'),
		formatSyncStat(result.deletedLocal, 'local deleted'),
		formatSyncStat(result.deletedRemote, 'remote deleted'),
		formatSyncStat(result.conflicts, 'conflict', 'conflicts'),
	].filter((stat): stat is string => stat !== undefined);

	if (stats.length === 0) {
		return { label: 'Synced', kind: 'success' };
	}

	return { label: 'Synced', details: stats, kind: 'success' };
}

function formatSyncSuccessNotice(
	result: SyncResult,
	vaultName: string,
): string {
	const stats = [
		formatSyncStat(result.uploaded, 'uploaded'),
		formatSyncStat(result.downloaded, 'downloaded'),
		formatSyncStat(result.deletedLocal, 'local deleted'),
		formatSyncStat(result.deletedRemote, 'remote deleted'),
		formatSyncStat(result.conflicts, 'conflict', 'conflicts'),
	].filter((stat): stat is string => stat !== undefined);

	if (stats.length === 0) {
		return `${vaultName} is already synced.`;
	}

	return `${vaultName}: ${stats.join(', ')}.`;
}

function formatSyncStat(
	count: number,
	label: string,
	pluralLabel = label,
): string | undefined {
	if (count === 0) {
		return undefined;
	}

	return `${count} ${count === 1 ? label : pluralLabel}`;
}

function getAutoSyncIntervalMs(minutes: number): number {
	return normalizeAutoSyncIntervalMinutes(minutes) * 60 * 1000;
}

function normalizeAutoSyncIntervalMinutes(minutes: number): number {
	if (
		!Number.isFinite(minutes) ||
		!AUTO_SYNC_INTERVAL_OPTIONS.includes(minutes as AutoSyncIntervalOption)
	) {
		return DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
	}

	return minutes;
}

type AutoSyncIntervalOption = (typeof AUTO_SYNC_INTERVAL_OPTIONS)[number];

function shouldTrackLocalChange(path: string, oldPath?: string): boolean {
	if (oldPath !== undefined) {
		return !isConflictPath(path) || !isConflictPath(oldPath);
	}

	return !isConflictPath(path);
}

function isConflictPath(path: string): boolean {
	return path === CONFLICTS_FOLDER || path.startsWith(`${CONFLICTS_FOLDER}/`);
}
