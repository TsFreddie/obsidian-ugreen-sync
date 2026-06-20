import {
	App,
	ButtonComponent,
	Modal,
	Notice,
	PluginSettingTab,
	Setting,
	SettingGroup,
	normalizePath,
	type DropdownComponent,
	type ExtraButtonComponent,
	type ToggleComponent,
} from 'obsidian';
import type UgreenSyncPlugin from './main';
import { RemoteDirectoryPickerModal } from './remote-browser';
import { formatUgreenError, getRemoteBaseDirAccessError, prepareAuthenticatedUgreenClient } from './ugreen';

const REMOTE_BASE_DIR_CHECK_DEBOUNCE_MS = 600;
const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 15;
const AUTO_SYNC_INTERVAL_OPTIONS: Record<string, string> = {
	'1': '1 minute',
	'5': '5 minutes',
	'15': '15 minutes',
	'30': '30 minutes',
	'60': '1 hour',
};

export class UgreenSyncSettingTab extends PluginSettingTab {
	plugin: UgreenSyncPlugin;
	private actionsHeaderClicks = 0;
	private diagnosticsVisible = false;
	private remoteBaseDirCheckId = 0;
	private remoteBaseDirCheckTimeout?: number;
	private autoSyncIntervalDropdown?: DropdownComponent;
	private autoSyncToggle?: ToggleComponent;
	private nasDirBlockWarningEl?: HTMLElement;

	constructor(app: App, plugin: UgreenSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.autoSyncIntervalDropdown = undefined;
		this.autoSyncToggle = undefined;

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
			.setName(isSignedIn ? 'Signed in' : 'Not signed in')
			.setDesc(
				isSignedIn
					? `Signed in${this.plugin.settings.username.trim() === '' ? '.' : ` as ${this.plugin.settings.username}.`}`
					: 'Sign in before running sync.',
			)
			.addButton((button) => {
				if (isSignedIn) {
					button.setButtonText('Log out').onClick(() => {
						new LogoutConfirmModal(
							this.app,
							async () => {
								await this.plugin.logout();
								// eslint-disable-next-line @typescript-eslint/no-deprecated -- Path B dual support: <1.13.0 fallback
								this.display();
							},
						).open();
					});
					return;
				}

				button
					.setButtonText('Sign in')
					.setCta()
					.onClick(() => {
						// eslint-disable-next-line @typescript-eslint/no-deprecated -- Path B dual support: <1.13.0 fallback
						void this.plugin.signIn().then(() => this.display());
					});
			});

		const settingsCard = this.createSection(containerEl, 'Settings').cardEl;
		new Setting(settingsCard)
			.setName('NAS sync directory')
			.setDesc('The plugin creates this directory on the NAS if it does not exist.')
			.addText((text) => {
				text.inputEl.disabled = !isSignedIn;
				text
					.setPlaceholder(isSignedIn ? 'Browse to select' : 'Sign in to config')
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
				button.setButtonText('Browse').onClick(async () => {
					try {
						const client = await prepareAuthenticatedUgreenClient(this.plugin.settings);
						new RemoteDirectoryPickerModal(this.app, {
							client,
							initialPath: this.plugin.settings.remoteBaseDir,
							vaultName: this.app.vault.getName(),
							onChoose: async (path) => {
								await this.plugin.setRemoteBaseDir(normalizeRemoteBaseDir(path));
								// eslint-disable-next-line @typescript-eslint/no-deprecated -- Path B dual support: <1.13.0 fallback
								this.display();
							},
						}).open();
					} catch (error) {
						new Notice(`Could not open NAS browser: ${formatUgreenError(error)}`, 8000);
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
			.setName('Auto sync')
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
			.setName('Auto-sync interval')
			.setDesc('How often automatic sync runs while auto-sync is enabled.')
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(AUTO_SYNC_INTERVAL_OPTIONS)
					.setValue(String(normalizeAutoSyncIntervalMinutes(this.plugin.settings.autoSyncIntervalMinutes)))
					.onChange(async (value) => {
						await this.plugin.setAutoSyncIntervalMinutes(normalizeAutoSyncIntervalMinutes(Number(value)));
					});
				this.autoSyncIntervalDropdown = dropdown;
				this.refreshAutoSyncControls();
			});

		const actionsSection = this.createSection(containerEl, 'Actions');
		const actionsCard = actionsSection.cardEl;
		const actionsHeading = actionsSection.headingSetting!;
		actionsHeading.nameEl.addEventListener('click', () => {
			this.actionsHeaderClicks += 1;
			if (this.actionsHeaderClicks < 5) {
				return;
			}

			this.actionsHeaderClicks = 0;
			this.diagnosticsVisible = true;
			// eslint-disable-next-line @typescript-eslint/no-deprecated -- Path B dual support: <1.13.0 fallback
			this.display();
		});

		new Setting(actionsCard)
			.setName('Manual sync')
			.setDesc('Run a sync operation immediately.')
			.addButton((button) => {
				actionButtons.push(button.buttonEl);
				button.buttonEl.disabled = !actionsEnabled;
				button
					.setButtonText('Sync now')
					.setCta()
					.onClick(() => {
						void this.plugin.syncNow();
					});
			});

		new Setting(actionsCard)
			.setName('Conflict resolver')
			.setDesc('Conflicted files are stored in .conflicts. You can resolve them using the resolver, or manually clear out the .conflicts folder.')
			.addButton((button) => {
				actionButtons.push(button.buttonEl);
				button.buttonEl.disabled = !actionsEnabled;
				button.setButtonText('Resolve conflicts').onClick(() => {
					void this.plugin.resolveConflicts();
				});
			});

		new Setting(actionsCard)
			.setName('Sync history')
			.setDesc(
				this.plugin.settings.lastSyncAt === 0
					? 'This vault has not synced yet.'
					: `Last synced ${new Date(this.plugin.settings.lastSyncAt).toLocaleString()}.`,
			)
			.addButton((button) => {
				actionButtons.push(button.buttonEl);
				button.buttonEl.disabled = !actionsEnabled;
				button.setButtonText('Reset history').onClick(() => {
					new ResetHistoryConfirmModal(
						this.app,
						async () => {
							await this.plugin.clearSyncHistory();
							new Notice('UGREEN sync history reset. Files were not deleted.');
							// eslint-disable-next-line @typescript-eslint/no-deprecated -- Path B dual support: <1.13.0 fallback
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
		this.updateNasDirBlockWarning();
		if (this.containerEl.isConnected) {
			// eslint-disable-next-line @typescript-eslint/no-deprecated -- Path B dual support: <1.13.0 fallback
			this.display();
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
		const diagnosticsCard = this.createSection(containerEl, 'Diagnostics').cardEl;

		new Setting(diagnosticsCard)
			.setName('Show diagnostics')
			.setDesc('Turn this off to hide diagnostics settings again.')
			.addToggle((toggle) =>
				toggle.setValue(true).onChange((value) => {
					this.diagnosticsVisible = value;
					if (!value) {
						// eslint-disable-next-line @typescript-eslint/no-deprecated -- Path B dual support: <1.13.0 fallback
						this.display();
					}
				}),
			);

		new Setting(diagnosticsCard)
			.setName('Debug logging')
			.setDesc('Log sync decisions and file operations to the developer console.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
					if (value) {
						// eslint-disable-next-line obsidianmd/rule-custom-message -- Confirms user-enabled diagnostics are active.
						console.log('[UGREEN Sync] debug logging enabled');
					}
				}),
			);
	}

	// ---- Declarative settings (Obsidian 1.13.0+ only) ----
	/* eslint-disable obsidianmd/no-unsupported-api -- Path B: 1.13.0+ APIs only invoked on supporting versions */

	getSettingDefinitions(): ReturnType<PluginSettingTab['getSettingDefinitions']> {
		return [
			{
				type: 'group' as const,
				items: [
					{
						name: 'Connection',
						render: (_setting: Setting, _group: SettingGroup) => {
							const isSignedIn = this.plugin.settings.session !== undefined;
							_setting.setName(isSignedIn ? 'Signed in' : 'Not signed in');
							_setting.setDesc(
								isSignedIn
									? `Signed in${this.plugin.settings.username.trim() === '' ? '.' : ` as ${this.plugin.settings.username}.`}`
									: 'Sign in before running sync.',
							);
							_setting.addButton((button) => {
								if (isSignedIn) {
									button.setButtonText('Log out').onClick(() => {
										new LogoutConfirmModal(
											this.app,
											async () => {
												await this.plugin.logout();
												this.update();
											},
										).open();
									});
									return;
								}
								button
									.setButtonText('Sign in')
									.setCta()
									.onClick(() => {
										void this.plugin.signIn().then(() => this.update());
									});
							});
						},
					},
				],
			},
			{
				type: 'group' as const,
				heading: 'Settings',
				items: [
					{
						name: 'NAS sync directory',
						render: (setting: Setting, group: SettingGroup) => {
							const isSignedIn = this.plugin.settings.session !== undefined;
							setting.setDesc(
								'The plugin creates this directory on the NAS if it does not exist.',
							);
							setting.addText((text) => {
								text.inputEl.disabled = !isSignedIn;
								text
									.setPlaceholder(isSignedIn ? 'Browse to select' : 'Sign in to config')
									.setValue(isSignedIn ? this.plugin.settings.remoteBaseDir : '')
									.onChange(async (value) => {
										await this.plugin.setRemoteBaseDir(normalizeRemoteBaseDir(value));
										this.update();
										this.scheduleRemoteBaseDirAccessCheck(messageEl, REMOTE_BASE_DIR_CHECK_DEBOUNCE_MS);
									});
							});
							setting.addButton((button) => {
								button.buttonEl.disabled = !isSignedIn;
								button.setButtonText('Browse').onClick(async () => {
									try {
										const client = await prepareAuthenticatedUgreenClient(this.plugin.settings);
										new RemoteDirectoryPickerModal(this.app, {
											client,
											initialPath: this.plugin.settings.remoteBaseDir,
											vaultName: this.app.vault.getName(),
											onChoose: async (path) => {
												await this.plugin.setRemoteBaseDir(normalizeRemoteBaseDir(path));
												this.update();
											},
										}).open();
									} catch (error) {
										new Notice(`Could not open NAS browser: ${formatUgreenError(error)}`, 8000);
									}
								});
							});
							const messageEl = group.listEl.createDiv({ cls: 'ugreen-sync-setting-message' });
							this.scheduleRemoteBaseDirAccessCheck(messageEl, 0);

							if (
								this.plugin.settings.autoSyncManualBlockReason ===
								'nas-dir-changed'
							) {
								const blockWarningEl = group.listEl.createDiv({
									cls: 'ugreen-sync-setting-message mod-warning',
								});
								blockWarningEl.setText(
									`Sync is blocked because the NAS directory was changed. Restore it to "${this.plugin.settings.lastSyncRemoteDir}" or reset sync history in Actions.`,
								);
							}
						},
					},
					{
						name: 'Auto sync',
						desc: getAutoSyncDescription(this.plugin.settings.hasPendingChanges, this.plugin.settings.lastLocalChangeAt),
						control: { type: 'toggle' as const, key: 'autoSyncEnabled', disabled: () => !this.hasActionsEnabled() },
					},
					{
						name: 'Auto-sync interval',
						desc: 'How often automatic sync runs while auto-sync is enabled.',
						control: {
						type: 'dropdown' as const,
							key: 'autoSyncIntervalMinutes',
							defaultValue: String(DEFAULT_AUTO_SYNC_INTERVAL_MINUTES),
							options: AUTO_SYNC_INTERVAL_OPTIONS,
							disabled: () => !this.hasActionsEnabled(),
						},
					},
				],
			},
			{
				type: 'group' as const,
				heading: 'Actions',
				extraButtons: [
					(btn: ExtraButtonComponent) => {
						btn.setIcon('lucide-ellipsis');
						btn.setTooltip('');
						btn.onClick(() => {
							this.actionsHeaderClicks += 1;
							if (this.actionsHeaderClicks >= 5) {
								this.actionsHeaderClicks = 0;
								this.diagnosticsVisible = true;
								this.update();
							}
						});
					},
				],
				items: [
					{
						name: 'Manual sync',
						render: (setting: Setting) => {
							const actionsEnabled = this.hasActionsEnabled();
							setting.setDesc('Run a sync operation immediately.');
							setting.addButton((button) => {
								button.buttonEl.disabled = !actionsEnabled;
								button
									.setButtonText('Sync now')
									.setCta()
									.onClick(() => {
										void this.plugin.syncNow();
									});
							});
						},
					},
					{
						name: 'Conflict resolver',
						render: (setting: Setting) => {
							const actionsEnabled = this.hasActionsEnabled();
							setting.setDesc(
								'Conflicted files are stored in .conflicts. You can resolve them using the resolver, or manually clear out the .conflicts folder.',
							);
							setting.addButton((button) => {
								button.buttonEl.disabled = !actionsEnabled;
								button.setButtonText('Resolve conflicts').onClick(() => {
									void this.plugin.resolveConflicts();
								});
							});
						},
					},
					{
						name: 'Sync history',
						render: (setting: Setting) => {
							const actionsEnabled = this.hasActionsEnabled();
							setting.setDesc(
								this.plugin.settings.lastSyncAt === 0
									? 'This vault has not synced yet.'
									: `Last synced ${new Date(this.plugin.settings.lastSyncAt).toLocaleString()}.`,
							);
							setting.addButton((button) => {
								button.buttonEl.disabled = !actionsEnabled;
								button.setButtonText('Reset history').onClick(() => {
									new ResetHistoryConfirmModal(
										this.app,
										async () => {
											await this.plugin.clearSyncHistory();
											new Notice('UGREEN sync history reset. Files were not deleted.');
											this.update();
										},
									).open();
								});
							});
						},
					},
				],
			},
			{
				type: 'group' as const,
				heading: 'Diagnostics',
				visible: () => this.diagnosticsVisible,
				items: [
					{
						name: 'Show diagnostics',
						render: (setting: Setting) => {
							setting.setDesc('Turn this off to hide diagnostics settings again.');
							setting.addToggle((toggle) =>
								toggle.setValue(true).onChange((value) => {
									this.diagnosticsVisible = value;
									if (!value) {
										this.update();
									}
								}),
							);
						},
					},
					{
						name: 'Debug logging',
						desc: 'Log sync decisions and file operations to the developer console.',
						control: { type: 'toggle' as const, key: 'debugLogging' },
					},
				],
			},
		];
	}

	setControlValue(key: string, value: unknown): void | Promise<void> {
		switch (key) {
			case 'autoSyncEnabled':
				return this.plugin.setAutoSyncEnabled(value as boolean);
			case 'autoSyncIntervalMinutes':
				return this.plugin.setAutoSyncIntervalMinutes(normalizeAutoSyncIntervalMinutes(Number(value)));
			case 'debugLogging':
				this.plugin.settings.debugLogging = value as boolean;
				return this.plugin.saveSettings();
			default:
				return super.setControlValue(key, value);
		}
	}

	getControlValue(key: string): unknown {
		if (key === 'autoSyncIntervalMinutes') {
			return String(this.plugin.settings.autoSyncIntervalMinutes);
		}
		return super.getControlValue(key);
	}

	/* eslint-enable obsidianmd/no-unsupported-api */

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
					`Could not check NAS sync directory access: ${formatUgreenError(error)}`,
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
			this.plugin.settings.autoSyncManualBlockReason === 'nas-dir-changed';
		this.nasDirBlockWarningEl.toggleClass('is-hidden', !blocked);
		if (blocked) {
			this.nasDirBlockWarningEl.setText(
				`Sync is blocked because the NAS directory was changed. Restore it to "${this.plugin.settings.lastSyncRemoteDir}" or reset sync history in Actions.`,
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
		this.setTitle('Reset sync history');
		this.contentEl.empty();

		this.contentEl.createEl('p', {
			text: 'This resets the sync state.',
		});
		this.contentEl.createEl('p', {
			text: 'Without a sync state, the next sync will perform a conservative two-way sync. Files that exist on only one side will be copied to the other side, and files that exist on both sides will be compared by content.',
		});
		this.contentEl.createEl('p', {
			text: 'Any content difference will be treated as a conflict and saved to the .conflicts folder.',
		});

		const actionsEl = this.contentEl.createDiv({
			cls: 'ugreen-sync-modal-actions',
		});
		new ButtonComponent(actionsEl)
			.setButtonText('Cancel')
			.onClick(() => this.close());
		new ButtonComponent(actionsEl)
			.setButtonText('Reset history')
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
		this.setTitle('Log out of UGREEN NAS');
		this.contentEl.empty();

		this.contentEl.createEl('p', {
			text: 'You will be signed out and the session will be cleared.',
		});
		this.contentEl.createEl('p', {
			text: 'Auto-sync and any pending sync operations will be cancelled. You will need to sign in again before syncing.',
		});

		const actionsEl = this.contentEl.createDiv({
			cls: 'ugreen-sync-modal-actions',
		});
		new ButtonComponent(actionsEl)
			.setButtonText('Cancel')
			.onClick(() => this.close());
		new ButtonComponent(actionsEl)
			.setButtonText('Log out')
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
	if (!Number.isFinite(minutes) || AUTO_SYNC_INTERVAL_OPTIONS[String(minutes)] === undefined) {
		return DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
	}

	return minutes;
}

function getAutoSyncDescription(hasPendingChanges: boolean, lastLocalChangeAt: number): string {
	if (!hasPendingChanges) {
		return 'Run sync automatically after launch checks, before hiding or quitting, and on the interval.';
	}

	if (lastLocalChangeAt === 0) {
		return 'Local changes have not synced yet.';
	}

	return `Local changes since ${new Date(lastLocalChangeAt).toLocaleString()} have not synced yet.`;
}