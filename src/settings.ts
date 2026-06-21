import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	PluginSettingTab,
	Setting,
	normalizePath,
	type DropdownComponent,	type ToggleComponent,
} from 'obsidian';
import type UgreenSyncPlugin from './main';
import { RemoteDirectoryPickerModal } from './remote-browser';
import { formatUgreenError, getRemoteBaseDirAccessError, prepareAuthenticatedUgreenClient } from './ugreen';
import { t } from './i18n';
import { makeModalKeyboardAware } from './mobile-keyboard';

const REMOTE_BASE_DIR_CHECK_DEBOUNCE_MS = 600;
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 15;

function getAutoSyncIntervalOptions(): Record<string, string> {
	return {
		'1': t('settings.interval_1min'),
		'5': t('settings.interval_5min'),
		'15': t('settings.interval_15min'),
		'30': t('settings.interval_30min'),
		'60': t('settings.interval_1hour'),
	};
}

export class UgreenSyncSettingTab extends PluginSettingTab {
	plugin: UgreenSyncPlugin;
	private actionsHeaderClicks = 0;
	private diagnosticsVisible = false;
	private remoteBaseDirCheckId = 0;
	private remoteBaseDirCheckTimeout?: number;
	private autoSyncIntervalDropdown?: DropdownComponent;
	private autoSyncToggle?: ToggleComponent;
	private nasDirBlockWarningEl?: HTMLElement;
	private syncNowButton?: ButtonComponent;

	constructor(app: App, plugin: UgreenSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.autoSyncIntervalDropdown = undefined;
		this.autoSyncToggle = undefined;
		this.syncNowButton = undefined;

		const connectionCard = this.createSection(containerEl).cardEl;

		const isSignedIn = this.plugin.settings.session !== undefined;
		const actionsEnabled = this.hasActionsEnabled();
		const actionButtons: HTMLButtonElement[] = [];
		const updateActionButtons = () => {
			const enabled = this.hasActionsEnabled();
			for (const buttonEl of actionButtons) {
				buttonEl.disabled = !enabled;
			}
		};
		new Setting(connectionCard)
			.setName(isSignedIn ? t('settings.signedIn') : t('settings.notSignedIn'))
			.setDesc(
				isSignedIn
					? formatConnectionDesc(
							this.plugin.settings.url,
							this.plugin.settings.ugreenLinkId,
							this.plugin.settings.username,
						)
					: t('settings.signInBeforeSync'),
			)
			.addButton((button) => {
				if (isSignedIn) {
					button.setButtonText(t('settings.logOut')).onClick(() => {
						new LogoutConfirmModal(
							this.app,
							async () => {
								await this.plugin.logout();
								this.display();
							},
						).open();
					});
					return;
				}

				button
					.setButtonText(t('settings.signIn'))
					.setCta()
					.onClick(() => {
						void this.plugin.signIn().then(() => this.display());
					});
			});

		const settingsCard = this.createSection(containerEl, t('settings.heading')).cardEl;
		new Setting(settingsCard)
			.setName(t('settings.nasSyncDir'))
			.setDesc(t('settings.nasSyncDirDesc'))
			.addText((text) => {
				text.inputEl.disabled = !isSignedIn;
				text
					.setPlaceholder(isSignedIn ? t('settings.browsePlaceholder') : t('settings.signInToConfigPlaceholder'))
					.setValue(isSignedIn ? this.plugin.settings.remoteBaseDir : '')
					.onChange(async (value) => {
						await this.plugin.setRemoteBaseDir(normalizeRemoteBaseDir(value));
						updateActionButtons();
						this.refreshAutoSyncControls();
						this.updateNasDirBlockWarning();
						this.scheduleRemoteBaseDirAccessCheck(remoteBaseDirMessageEl, REMOTE_BASE_DIR_CHECK_DEBOUNCE_MS);
					});
			})
			.addButton((button) => {
				button.buttonEl.disabled = !isSignedIn;
				button.setButtonText(t('settings.browse')).onClick(async () => {
					try {
						const client = await prepareAuthenticatedUgreenClient(this.plugin.settings);
						new RemoteDirectoryPickerModal(this.app, {
							client,
							initialPath: this.plugin.settings.remoteBaseDir,
							vaultName: this.app.vault.getName(),
							onChoose: async (path) => {
								await this.plugin.setRemoteBaseDir(normalizeRemoteBaseDir(path));
								this.display();
							},
						}).open();
					} catch (error) {
						new Notice(t('notice.couldNotOpenBrowser', { error: formatUgreenError(error) }), 8000);
					}
				});
			});
		const remoteBaseDirMessageEl = settingsCard.createDiv({ cls: 'ugreen-sync-setting-message' });
		this.scheduleRemoteBaseDirAccessCheck(remoteBaseDirMessageEl, 0);

		this.nasDirBlockWarningEl = settingsCard.createDiv({
			cls: 'ugreen-sync-setting-message mod-warning',
		});
		this.updateNasDirBlockWarning();

		new Setting(settingsCard)
			.setName(t('settings.autoSync'))
			.setDesc(getAutoSyncDescription(this.plugin.settings.hasPendingChanges, this.plugin.settings.lastLocalChangeAt))
			.addToggle((toggle) => {
				this.autoSyncToggle = toggle;
				this.refreshAutoSyncControls();
				toggle.onChange(async (value) => {
					if (!this.hasActionsEnabled()) {
						this.refreshAutoSyncControls();
						return;
					}

					await this.plugin.setAutoSyncEnabled(value);
					this.refreshAutoSyncControls();
				});
			});

		new Setting(settingsCard)
			.setName(t('settings.autoSyncInterval'))
			.setDesc(t('settings.autoSyncIntervalDesc'))
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(getAutoSyncIntervalOptions())
					.setValue(String(normalizeAutoSyncIntervalMinutes(this.plugin.settings.autoSyncIntervalMinutes)))
					.onChange(async (value) => {
						await this.plugin.setAutoSyncIntervalMinutes(normalizeAutoSyncIntervalMinutes(Number(value)));
					});
				this.autoSyncIntervalDropdown = dropdown;
				this.refreshAutoSyncControls();
			});

		const actionsSection = this.createSection(containerEl, t('settings.actions'));
		const actionsCard = actionsSection.cardEl;
		const actionsHeading = actionsSection.headingSetting!;
		actionsHeading.nameEl.addEventListener('click', () => {
			this.actionsHeaderClicks += 1;
			if (this.actionsHeaderClicks < 5) {
				return;
			}

			this.actionsHeaderClicks = 0;
			this.diagnosticsVisible = true;
			this.display();
		});

		new Setting(actionsCard)
			.setName(t('settings.manualSync'))
			.setDesc(t('settings.manualSyncDesc'))
			.addButton((button) => {
				this.syncNowButton = button;
				actionButtons.push(button.buttonEl);
				button.buttonEl.disabled = !actionsEnabled;
				button
					.setButtonText(t('settings.syncNowButton'))
					.setCta()
					.onClick(async () => {
						this.setSyncButtonState(true);
						try {
							await this.plugin.syncNow();
						} finally {
							this.setSyncButtonState(false);
						}
					});
			});

		new Setting(actionsCard)
			.setName(t('settings.conflictResolver'))
			.setDesc(t('settings.conflictResolverDesc'))
			.addButton((button) => {
				actionButtons.push(button.buttonEl);
				button.buttonEl.disabled = !actionsEnabled;
				button.setButtonText(t('settings.resolveConflicts')).onClick(() => {
					void this.plugin.resolveConflicts();
				});
			});

		new Setting(actionsCard)
			.setName(t('settings.syncHistory'))
			.setDesc(
				this.plugin.settings.lastSyncAt === 0
					? t('settings.neverSynced')
					: t('settings.lastSynced', { time: new Date(this.plugin.settings.lastSyncAt).toLocaleString() }),
			)
			.addButton((button) => {
				actionButtons.push(button.buttonEl);
				button.buttonEl.disabled = !actionsEnabled;
				button.setButtonText(t('settings.resetHistory')).onClick(() => {
					new ResetHistoryConfirmModal(
						this.app,
						async () => {
							await this.plugin.clearSyncHistory();
							new Notice(t('notice.resetHistory'));
							this.display();
						},
					).open();
				});
			});

		if (this.diagnosticsVisible) {
			this.displayDiagnostics(containerEl);
		}
	}

	refreshAutoSyncControls(): void {
		const actionsEnabled = this.hasActionsEnabled();
		this.autoSyncToggle?.toggleEl.toggleClass('is-disabled', !actionsEnabled);
		this.autoSyncToggle?.toggleEl.setAttribute('aria-disabled', String(!actionsEnabled));
		this.autoSyncToggle?.setValue(this.plugin.settings.autoSyncEnabled);

		if (this.autoSyncIntervalDropdown !== undefined) {
			this.autoSyncIntervalDropdown.selectEl.disabled = !actionsEnabled;
			this.autoSyncIntervalDropdown.setValue(
				String(
					normalizeAutoSyncIntervalMinutes(
						this.plugin.settings.autoSyncIntervalMinutes,
					),
				),
			);
		}
	}

	refreshAfterSync(): void {
		this.setSyncButtonState(false);
		this.updateNasDirBlockWarning();
		if (this.containerEl.isConnected) {
			this.display();
		}
	}

	private setSyncButtonState(syncing: boolean): void {
		if (this.syncNowButton === undefined) {
			return;
		}
		this.syncNowButton.setDisabled(syncing);
		if (syncing) {
			this.syncNowButton.setButtonText(t('settings.syncingButton'));
			this.syncNowButton.buttonEl.removeClass('mod-cta');
		} else {
			this.syncNowButton.setButtonText(t('settings.syncNowButton'));
			this.syncNowButton.setCta();
		}
	}

	private hasActionsEnabled(): boolean {
		return this.plugin.settings.session !== undefined && this.plugin.settings.remoteBaseDir.trim() !== '';
	}

	private createSection(
		containerEl: HTMLElement,
		heading?: string,
	): { cardEl: HTMLElement; headingSetting?: Setting } {
		const sectionEl = containerEl.createDiv({ cls: 'setting-group' });
		const headingSetting = heading === undefined
			? undefined
			: new Setting(sectionEl).setName(heading).setHeading();
		const cardEl = sectionEl.createDiv({ cls: 'setting-items' });
		return { cardEl, headingSetting };
	}

	private displayDiagnostics(containerEl: HTMLElement): void {
		const diagnosticsCard = this.createSection(containerEl, t('settings.diagnostics')).cardEl;

		new Setting(diagnosticsCard)
			.setName(t('settings.showDiagnostics'))
			.setDesc(t('settings.showDiagnosticsDesc'))
			.addToggle((toggle) =>
				toggle.setValue(true).onChange((value) => {
					this.diagnosticsVisible = value;
					if (!value) {
						this.display();
					}
				}),
			);

		new Setting(diagnosticsCard)
			.setName(t('settings.debugLogging'))
			.setDesc(t('settings.debugLoggingDesc'))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
					if (value) {
						console.debug('[UGREEN Sync] debug logging enabled');
					}
				}),
			);
	}

	private scheduleRemoteBaseDirAccessCheck(messageEl: HTMLElement, delay: number): void {
		if (this.remoteBaseDirCheckTimeout !== undefined) {
			window.clearTimeout(this.remoteBaseDirCheckTimeout);
			this.remoteBaseDirCheckTimeout = undefined;
		}

		const checkId = ++this.remoteBaseDirCheckId;
		this.setRemoteBaseDirMessage(messageEl, '');
		if (this.plugin.settings.session === undefined || this.plugin.settings.remoteBaseDir.trim() === '') {
			return;
		}

		this.remoteBaseDirCheckTimeout = window.setTimeout(() => {
			this.remoteBaseDirCheckTimeout = undefined;
			void this.checkRemoteBaseDirAccess(messageEl, checkId);
		}, delay);
	}

	private async checkRemoteBaseDirAccess(messageEl: HTMLElement, checkId: number): Promise<void> {
		try {
			const accessError = await getRemoteBaseDirAccessError(this.plugin.settings);
			if (checkId === this.remoteBaseDirCheckId && messageEl.isConnected) {
				this.setRemoteBaseDirMessage(messageEl, accessError ?? '');
			}
		} catch (error) {
			if (checkId === this.remoteBaseDirCheckId && messageEl.isConnected) {
				this.setRemoteBaseDirMessage(
					messageEl,
					t('notice.checkNasAccessFailed', { error: formatUgreenError(error) }),
				);
			}
		}
	}

	private setRemoteBaseDirMessage(messageEl: HTMLElement, message: string): void {
		messageEl.setText(message);
		messageEl.toggleClass('is-hidden', message === '');
	}

	private updateNasDirBlockWarning(): void {
		if (this.nasDirBlockWarningEl === undefined) {
			return;
		}

		const blocked =
			this.plugin.settings.autoSyncManualBlockReason === 'nas-dir-changed' &&
			this.plugin.settings.remoteBaseDir.trim() !== '';
		this.nasDirBlockWarningEl.toggleClass('is-hidden', !blocked);
		if (blocked) {
			this.nasDirBlockWarningEl.setText(
				t('settings.syncBlockedNasDir', { path: this.plugin.settings.lastSyncRemoteDir }),
			);
		}
	}
}

function normalizeRemoteBaseDir(value: string): string {
	const cleanPath = normalizePath(value.trim()).replace(/^\/+|\/+$/g, '');
	return cleanPath === '' ? '' : `/${cleanPath}`;
}

class ResetHistoryConfirmModal extends Modal {
	private onConfirm: () => Promise<void>;

	constructor(app: App, onConfirm: () => Promise<void>) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen() {
		this.modalEl.addClass('ugreen-sync-reset-history-modal');
		makeModalKeyboardAware(this);
		this.setTitle(t('modal.resetHistoryTitle'));
		this.contentEl.empty();

		this.contentEl.createEl('p', {
			text: t('modal.resetHistoryLine1'),
		});
		this.contentEl.createEl('p', {
			text: t('modal.resetHistoryLine2'),
		});
		this.contentEl.createEl('p', {
			text: t('modal.resetHistoryLine3'),
		});

		const actionsEl = this.contentEl.createDiv({
			cls: 'ugreen-sync-modal-actions',
		});
		new ButtonComponent(actionsEl)
			.setButtonText(t('modal.cancel'))
			.onClick(() => this.close());
		new ButtonComponent(actionsEl)
			.setButtonText(t('modal.resetHistory'))
			.setCta()
			.onClick(() => {
				void this.onConfirm().then(() => this.close());
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}

class LogoutConfirmModal extends Modal {
	private onConfirm: () => Promise<void>;

	constructor(app: App, onConfirm: () => Promise<void>) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen() {
		this.modalEl.addClass('ugreen-sync-reset-history-modal');
		makeModalKeyboardAware(this);
		this.setTitle(t('modal.logoutTitle'));
		this.contentEl.empty();

		this.contentEl.createEl('p', {
			text: t('modal.logoutLine1'),
		});
		this.contentEl.createEl('p', {
			text: t('modal.logoutLine2'),
		});

		const actionsEl = this.contentEl.createDiv({
			cls: 'ugreen-sync-modal-actions',
		});
		new ButtonComponent(actionsEl)
			.setButtonText(t('modal.cancel'))
			.onClick(() => this.close());
		new ButtonComponent(actionsEl)
			.setButtonText(t('modal.logOut'))
			.setCta()
			.onClick(() => {
				void this.onConfirm().then(() => this.close());
			});
	}

	onClose() {
		this.contentEl.empty();
	}
}

function normalizeAutoSyncIntervalMinutes(minutes: number): number {
	if (!Number.isFinite(minutes) || getAutoSyncIntervalOptions()[String(minutes)] === undefined) {
		return DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
	}

	return minutes;
}

function getAutoSyncDescription(hasPendingChanges: boolean, lastLocalChangeAt: number): string {
	if (!hasPendingChanges) {
		return t('settings.autoSyncDesc');
	}

	if (lastLocalChangeAt === 0) {
		return t('settings.autoSyncPending');
	}

	return t('settings.autoSyncPendingSince', { time: new Date(lastLocalChangeAt).toLocaleString() });
}

function formatConnectionDesc(url: string, ugreenLinkId: string, username: string): string {
	const parts: string[] = [];

	if (ugreenLinkId.trim() !== '') {
		parts.push(`UGREENlink: ${ugreenLinkId}`);
	} else {
		const isHttp = url.trim().toLowerCase().startsWith('http://');
		const host = url.trim().replace(/^https?:\/\//i, '');
		parts.push(`${isHttp ? 'HTTP' : 'HTTPS'}: ${host}`);
	}

	if (username.trim() !== '') {
		parts.push(username);
	}

	return parts.join(' — ');
}