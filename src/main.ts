import { Menu, Notice, Plugin, setIcon, type App, type IconName } from 'obsidian';
import { openUgreenLoginModal } from './login';
import { UgreenSyncSettingTab } from './settings';
import { DEFAULT_SETTINGS, SyncProgress, SyncResult, UgreenSyncSettings } from './types';
import { runSync } from './sync';
import { formatUgreenError, getRemoteBaseDirAccessError, hasValidUgreenSession, logUgreenError } from './ugreen';
import { hasUnresolvedConflicts, openConflictPrompt, openConflictResolver } from './conflicts';
import { debugLog } from './debug';

export default class UgreenSyncPlugin extends Plugin {
	settings!: UgreenSyncSettings;
	private statusBarItem?: HTMLElement;
	private statusIconEl?: HTMLElement;
	private statusIconName?: IconName;
	private statusProgressEl?: HTMLElement;
	private latestStatus: SyncStatus = { label: 'Checking', kind: 'running' };
	private syncInProgress = false;

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
		this.registerEvent(this.app.vault.on('create', () => void this.updateConflictStatus()));
		this.registerEvent(this.app.vault.on('delete', () => void this.updateConflictStatus()));
		this.registerEvent(this.app.vault.on('rename', () => void this.updateConflictStatus()));

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

		this.addSettingTab(new UgreenSyncSettingTab(this.app, this));
	}

	async syncNow() {
		if (!this.isSignedIn()) {
			this.setStatus({ label: 'Logged out', kind: 'warning' });
			new Notice('Sign in to UGREEN NAS before syncing.');
			return;
		}
		if (!this.hasRemoteBaseDir()) {
			this.setStatus({ label: 'No NAS directory', kind: 'warning' });
			new Notice('Set a NAS sync directory before syncing.');
			return;
		}

		if (this.syncInProgress) {
			new Notice('UGREEN sync is already running.');
			return;
		}

		if (!(await this.ensureSignedIn())) {
			this.setStatus({ label: 'Logged out', kind: 'warning' });
			return;
		}

		if (await hasUnresolvedConflicts(this.app.vault)) {
			await this.updateConflictStatus();
			openConflictPrompt(this.app, () => {
				void this.resolveConflicts();
			});
			return;
		}

		try {
			this.syncInProgress = true;
			this.setStatus({ label: 'Syncing', kind: 'running' });

			const result = await runSync(this.app.vault, this.settings, (progress) => {
				this.setStatus({
					label: 'Syncing',
					kind: 'running',
					progress: getSyncProgressPercent(progress),
				});
			});
			this.settings.syncState = result.syncState;
			this.settings.lastSyncAt = Date.now();
			await this.saveSettings();

			this.setStatus(formatSyncStatusMessage(result));
			new Notice(formatSyncSuccessNotice(result, this.app.vault.getName()));
		} catch (error) {
			const errorMessage = formatUgreenError(error);
			logUgreenError('sync failed', error);
			this.setStatus({ label: 'Failed', details: [errorMessage], kind: 'error' });
			new Notice(`UGREEN sync failed: ${errorMessage}`, 8000);
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

		await openConflictResolver(this.app, () => {
			void this.updateConflictStatus();
		});
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
		await this.saveSettings();
		this.setStatus({ label: 'Logged in', kind: 'success' });
		void this.checkRemoteBaseDirAccessAfterLogin();
		void this.updateConflictStatus();
		return true;
	}

	async logout() {
		this.settings.session = undefined;
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
			debugLog(this.settings, 'startup session check skipped', { reason: 'missing session' });
			this.setStatus({ label: 'Logged out', kind: 'warning' });
			void this.updateConflictStatus();
			return;
		}

		try {
			if (await hasValidUgreenSession(this.settings)) {
				debugLog(this.settings, 'startup session check success');
				this.setStatus({ label: 'Logged in', kind: 'success' });
				void this.updateConflictStatus();
				return;
			}

			debugLog(this.settings, 'startup session check expired');
			this.settings.session = undefined;
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

	private async ensureSignedIn(): Promise<boolean> {
		if (this.settings.session !== undefined) {
			try {
				if (await hasValidUgreenSession(this.settings)) {
					return true;
				}
			} catch (error) {
				logUgreenError('session check failed', error);
				new Notice(`UGREEN NAS session check failed: ${formatUgreenError(error)}`, 8000);
				return false;
			}

			this.settings.session = undefined;
			await this.saveSettings();
		}

		return this.signIn();
	}

	private isSignedIn(): boolean {
		return this.settings.session !== undefined;
	}

	private hasRemoteBaseDir(): boolean {
		return this.settings.remoteBaseDir.trim() !== '';
	}

	private async checkRemoteBaseDirAccessAfterLogin(): Promise<void> {
		if (!this.hasRemoteBaseDir()) {
			return;
		}

		try {
			const accessError = await getRemoteBaseDirAccessError(this.settings);
			if (accessError !== undefined) {
				new Notice(accessError, 8000);
			}
		} catch (error) {
			logUgreenError('remote base directory access check failed', error);
			new Notice(`Could not check NAS sync directory access: ${formatUgreenError(error)}`, 8000);
		}
	}

	async loadSettings() {
		const savedData = ((await this.loadData()) ?? {}) as Partial<UgreenSyncSettings>;
		const savedSettings = Object.fromEntries(
			Object.entries({
				url: savedData.url,
				ugreenLinkId: savedData.ugreenLinkId,
				username: savedData.username,
				session: savedData.session,
				remoteBaseDir: savedData.remoteBaseDir,
				debugLogging: savedData.debugLogging,
				syncState: savedData.syncState,
				lastSyncAt: savedData.lastSyncAt,
			}).filter(([, value]) => value !== undefined),
		) as Partial<UgreenSyncSettings>;

		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			savedSettings,
		);
	}

	async saveSettings() {
		await this.saveData({
			url: this.settings.url,
			ugreenLinkId: this.settings.ugreenLinkId,
			username: this.settings.username,
			session: this.settings.session,
			remoteBaseDir: this.settings.remoteBaseDir,
			debugLogging: this.settings.debugLogging,
			syncState: this.settings.syncState,
			lastSyncAt: this.settings.lastSyncAt,
		});
	}

	private setStatus(status: SyncStatus) {
		this.latestStatus = status;
		if (this.statusBarItem === undefined) {
			return;
		}
		const statusText = formatStatusText(status);
		const statusClass = this.getStatusClass(status);
		const statusIcon = this.getStatusIcon(status);

		this.statusBarItem.toggleClass('ugreen-sync-status-running', statusClass === 'ugreen-sync-status-running');
		this.statusBarItem.toggleClass('ugreen-sync-status-warning', statusClass === 'ugreen-sync-status-warning');
		this.statusBarItem.toggleClass('ugreen-sync-status-success', statusClass === 'ugreen-sync-status-success');
		this.statusBarItem.toggleClass('ugreen-sync-conflict-status', statusClass === 'ugreen-sync-conflict-status');
		this.updateStatusIcon(statusIcon, status.progress);
		this.statusBarItem.setAttribute('aria-label', `${statusText}. Open UGREEN sync menu`);
		this.statusBarItem.setAttribute('title', statusText);
	}

	private updateStatusIcon(iconName: IconName, progress: number | undefined): void {
		if (this.statusBarItem === undefined) {
			return;
		}

		if (this.statusIconEl === undefined || this.statusIconName !== iconName) {
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
			item
				.setTitle(this.createStatusMenuTitle())
				.setIsLabel(true)
				.setSection('ugreen-sync-status');
		});
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle('Sync now')
				.setIcon('sync')
				.setDisabled(!this.isSignedIn() || !this.hasRemoteBaseDir() || this.syncInProgress)
				.onClick(() => {
					void this.syncNow();
				});
		});
		menu.addItem((item) => {
			item
				.setTitle('Settings')
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
		if (status.kind === 'warning') {
			return 'ugreen-sync-status-warning';
		}

		return 'ugreen-sync-status-success';
	}

	private showStatusMenuAtStatusBar(): void {
		const rect = this.statusBarItem?.getBoundingClientRect();
		if (rect === undefined) {
			return;
		}

		this.showStatusMenu(new MouseEvent('click', {
			clientX: rect.left,
			clientY: rect.top,
			view: activeWindow,
		}));
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
		if (!this.isSignedIn() || !this.hasRemoteBaseDir()) {
			this.statusBarItem?.removeClass('ugreen-sync-conflict-status');
			return;
		}

		const hasConflicts = await hasUnresolvedConflicts(this.app.vault);
		const conflictStatus: SyncStatus = { label: 'Conflicts', kind: 'error' };
		if (hasConflicts) {
			this.setStatus(conflictStatus);
		} else if (this.latestStatus.label === conflictStatus.label && this.latestStatus.kind === conflictStatus.kind) {
			this.setStatus({ label: 'Ready', kind: 'success' });
		} else {
			this.statusBarItem?.removeClass('ugreen-sync-conflict-status');
		}
	}
}

type SyncStatusKind = 'running' | 'warning' | 'success' | 'error';

interface SyncStatus {
	label: string;
	details?: string[];
	kind: SyncStatusKind;
	progress?: number;
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

function getSyncProgressPercent(progress: SyncProgress): number {
	if (progress.total <= 0) {
		return 100;
	}

	return Math.min(100, Math.max(0, Math.round((progress.completed / progress.total) * 100)));
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

function formatSyncSuccessNotice(result: SyncResult, vaultName: string): string {
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

function formatSyncStat(count: number, label: string, pluralLabel = label): string | undefined {
	if (count === 0) {
		return undefined;
	}

	return `${count} ${count === 1 ? label : pluralLabel}`;
}
