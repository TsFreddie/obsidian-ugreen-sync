import { Notice, Plugin } from 'obsidian';
import { UgreenSyncSettingTab } from './settings';
import { DEFAULT_SETTINGS, UgreenSyncSettings } from './types';
import { runSync } from './sync';
import { createUgreenClient, formatUgreenError, logUgreenError } from './ugreen';
import { hasUnresolvedConflicts, openConflictPrompt, openConflictResolver } from './conflicts';

export default class UgreenSyncPlugin extends Plugin {
	settings!: UgreenSyncSettings;
	private statusBarItem?: HTMLElement;
	private ribbonIcon?: HTMLElement;
	private syncInProgress = false;

	async onload() {
		await this.loadSettings();

		this.ribbonIcon = this.addRibbonIcon('sync', 'Sync with ugreen nas', () => {
			void this.syncNow();
		});

		this.statusBarItem = this.addStatusBarItem();
		this.setStatus('UGREEN sync ready');
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
			name: 'Test ugreen nas connection',
			callback: () => {
				void this.testConnection();
			},
		});

		this.addSettingTab(new UgreenSyncSettingTab(this.app, this));
	}

	async syncNow() {
		if (this.syncInProgress) {
			new Notice('Ugreen sync is already running.');
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

	async testConnection() {
		try {
			const client = createUgreenClient(this.settings);
			await client.login();
			new Notice('Ugreen nas connection succeeded.');
		} catch (error) {
			logUgreenError('connection test failed', error);
			new Notice(`UGREEN NAS connection failed: ${formatUgreenError(error)}`, 8000);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<UgreenSyncSettings>,
		);
		if (this.settings.remoteBaseDir === '') {
			this.settings.remoteBaseDir = this.app.vault.getName();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
			hasConflicts ? conflictStatus : 'Sync with ugreen nas',
		);
		this.ribbonIcon?.setAttribute('aria-label-position', 'right');
		if (hasConflicts) {
			this.setStatus(conflictStatus);
		} else if (this.statusBarItem?.textContent === conflictStatus) {
			this.setStatus('UGREEN sync ready');
		}
	}
}
