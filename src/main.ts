import { Notice, Plugin } from 'obsidian';
import { openUgreenLoginModal } from './login';
import { UgreenSyncSettingTab } from './settings';
import { DEFAULT_SETTINGS, UgreenSyncSettings } from './types';
import { runSync } from './sync';
import { formatUgreenError, hasValidUgreenSession, logUgreenError } from './ugreen';
import { hasUnresolvedConflicts, openConflictPrompt, openConflictResolver } from './conflicts';
import { debugLog } from './debug';

export default class UgreenSyncPlugin extends Plugin {
	settings!: UgreenSyncSettings;
	private statusBarItem?: HTMLElement;
	private ribbonIcon?: HTMLElement;
	private syncInProgress = false;

	async onload() {
		await this.loadSettings();

		this.ribbonIcon = this.addRibbonIcon('sync', 'Sync with UGREEN NAS', () => {
			void this.syncNow();
		});

		this.statusBarItem = this.addStatusBarItem();
		this.setStatus('UGREEN sync checking sign-in...');
		void this.checkLoginOnLaunch();
		void this.updateConflictStatus();
		this.registerEvent(this.app.vault.on('create', () => void this.updateConflictStatus()));
		this.registerEvent(this.app.vault.on('delete', () => void this.updateConflictStatus()));
		this.registerEvent(this.app.vault.on('rename', () => void this.updateConflictStatus()));

		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => {
				void this.syncNow();
			},
		});

		this.addCommand({
			id: 'resolve-conflicts',
			name: 'Resolve sync conflicts',
			callback: () => {
				void this.resolveConflicts();
			},
		});

		this.addCommand({
			id: 'test-connection',
			name: 'Sign in to UGREEN NAS',
			callback: () => {
				void this.signIn();
			},
		});

		this.addSettingTab(new UgreenSyncSettingTab(this.app, this));
	}

	async syncNow() {
		if (this.syncInProgress) {
			new Notice('UGREEN sync is already running.');
			return;
		}

		if (!(await this.ensureSignedIn())) {
			this.setStatus('UGREEN sync needs sign-in');
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
			this.setStatus('UGREEN sync running...');

			const result = await runSync(this.app.vault, this.settings);
			this.settings.syncState = result.syncState;
			this.settings.lastSyncAt = Date.now();
			await this.saveSettings();

			const message = `UGREEN sync complete: ${result.uploaded} uploaded, ${result.downloaded} downloaded, ${result.deletedLocal} local deleted, ${result.deletedRemote} remote deleted, ${result.conflicts} conflicts.`;
			this.setStatus(message);
			new Notice(message);
		} catch (error) {
			const message = `UGREEN sync failed: ${formatUgreenError(error)}`;
			logUgreenError('sync failed', error);
			this.setStatus(message);
			new Notice(message, 8000);
		} finally {
			this.syncInProgress = false;
			void this.updateConflictStatus();
		}
	}

	async resolveConflicts() {
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
		this.setStatus('UGREEN sync signed in');
		return true;
	}

	async logout() {
		this.settings.session = undefined;
		await this.saveSettings();
		this.setStatus('UGREEN sync needs sign-in');
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
			this.setStatus('UGREEN sync needs sign-in');
			void this.updateConflictStatus();
			return;
		}

		try {
			if (await hasValidUgreenSession(this.settings)) {
				debugLog(this.settings, 'startup session check success');
				this.setStatus('UGREEN sync signed in');
				void this.updateConflictStatus();
				return;
			}

			debugLog(this.settings, 'startup session check expired');
			this.settings.session = undefined;
			await this.saveSettings();
			this.setStatus('UGREEN sync needs sign-in');
		} catch (error) {
			debugLog(this.settings, 'startup session check error', {
				message: formatUgreenError(error),
			});
			logUgreenError('startup session check failed', error);
			this.setStatus('UGREEN sync sign-in check failed');
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

	async loadSettings() {
		const savedSettings = ((await this.loadData()) ?? {}) as Partial<UgreenSyncSettings> & {
			password?: string;
		};
		delete savedSettings.password;

		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			savedSettings,
		);
		if (this.settings.remoteBaseDir === '') {
			this.settings.remoteBaseDir = this.app.vault.getName();
		}
	}

	async saveSettings() {
		const data = { ...this.settings } as Record<string, unknown>;
		delete data.password;
		await this.saveData(data);
	}

	private setStatus(message: string) {
		this.statusBarItem?.setText(message);
	}

	private async updateConflictStatus() {
		const hasConflicts = await hasUnresolvedConflicts(this.app.vault);
		const conflictStatus = 'UGREEN sync conflicts need resolution';
		this.ribbonIcon?.toggleClass('ugreen-sync-conflict-ribbon', hasConflicts);
		this.ribbonIcon?.toggleClass('mod-warning', hasConflicts);
		this.ribbonIcon?.setAttribute(
			'aria-label',
			hasConflicts ? conflictStatus : 'Sync with UGREEN NAS',
		);
		this.ribbonIcon?.setAttribute('aria-label-position', 'right');
		if (hasConflicts) {
			this.setStatus(conflictStatus);
		} else if (this.statusBarItem?.textContent === conflictStatus) {
			this.setStatus('UGREEN sync ready');
		}
	}
}
