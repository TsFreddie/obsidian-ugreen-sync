import { App, Notice, PluginSettingTab, Setting, TFolder, normalizePath } from 'obsidian';
import type UgreenSyncPlugin from './main';

export class UgreenSyncSettingTab extends PluginSettingTab {
	plugin: UgreenSyncPlugin;
	private folderToAdd = '/';

	constructor(app: App, plugin: UgreenSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Login').setHeading();

		const isSignedIn = this.plugin.settings.session !== undefined;
		new Setting(containerEl)
			.setName(isSignedIn ? 'Signed in' : 'Not signed in')
			.setDesc(
				isSignedIn
					? `Signed in${this.plugin.settings.username.trim() === '' ? '.' : ` as ${this.plugin.settings.username}.`}`
					: 'Sign in before running sync.',
			)
			.addButton((button) => {
				if (isSignedIn) {
					button.setButtonText('Log out').onClick(() => {
						void this.plugin.logout().then(() => this.display());
					});
					return;
				}

				button
					.setButtonText('Sign in')
					.setCta()
					.onClick(() => {
						void this.plugin.signIn().then(() => this.display());
					});
			});

		new Setting(containerEl).setName('Remote sync directory').setHeading();

		new Setting(containerEl)
			.setName('NAS sync directory')
			.setDesc('The plugin creates this directory on the NAS if it does not exist.')
			.addText((text) =>
				text
					.setPlaceholder(this.app.vault.getName())
					.setValue(this.plugin.settings.remoteBaseDir)
					.onChange(async (value) => {
						this.plugin.settings.remoteBaseDir = normalizeRemoteBaseDir(value);
						await this.plugin.saveSettings();
					}),
			)
			.addButton((button) =>
				button.setButtonText('Use vault name').onClick(async () => {
					this.plugin.settings.remoteBaseDir = normalizeRemoteBaseDir(
						this.app.vault.getName(),
					);
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		new Setting(containerEl).setName('Local folders').setHeading();
		containerEl.createEl('p', {
			text:
				this.plugin.settings.localFolders.length === 0
					? 'Sync scope: entire vault.'
					: 'Sync scope: selected folders only.',
		});

		new Setting(containerEl)
			.setName('Add local folder')
			.addDropdown((dropdown) => {
				for (const folder of getVaultFolders(this.app)) {
					dropdown.addOption(folder, folder === '/' ? 'Entire vault' : folder);
				}
				dropdown.setValue(this.folderToAdd);
				dropdown.onChange((value) => {
					this.folderToAdd = value;
				});
			})
			.addButton((button) =>
				button.setButtonText('Add').onClick(async () => {
					if (this.folderToAdd === '/') {
						this.plugin.settings.localFolders = [];
					} else if (!this.plugin.settings.localFolders.includes(this.folderToAdd)) {
						this.plugin.settings.localFolders = [
							...this.plugin.settings.localFolders,
							this.folderToAdd,
						].sort();
					}
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		for (const folder of this.plugin.settings.localFolders) {
			new Setting(containerEl)
				.setName(folder)
				.addButton((button) =>
					button.setButtonText('Remove').onClick(async () => {
						this.plugin.settings.localFolders = this.plugin.settings.localFolders.filter(
							(path) => path !== folder,
						);
						await this.plugin.saveSettings();
						this.display();
					}),
				);
		}

		new Setting(containerEl).setName('Diagnostics').setHeading();

		new Setting(containerEl)
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

		new Setting(containerEl).setName('Actions').setHeading();

		new Setting(containerEl)
			.setName('Manual sync')
			.setDesc('Runs a conservative two-way sync for the selected local folders.')
			.addButton((button) =>
				button
					.setButtonText('Sync now')
					.setCta()
					.onClick(() => {
						void this.plugin.syncNow();
					}),
			);

		new Setting(containerEl)
			.setName('Conflict resolver')
			.setDesc('Review files in .conflicts and choose which versions to keep.')
			.addButton((button) =>
				button.setButtonText('Resolve conflicts').onClick(() => {
					void this.plugin.resolveConflicts();
				}),
			);

		new Setting(containerEl)
			.setName('Sync history')
			.setDesc(
				this.plugin.settings.lastSyncAt === 0
					? 'This vault has not synced yet.'
					: `Last synced ${new Date(this.plugin.settings.lastSyncAt).toLocaleString()}.`,
			)
			.addButton((button) =>
				button.setButtonText('Reset history').onClick(async () => {
					this.plugin.settings.syncState = {};
					this.plugin.settings.lastSyncAt = 0;
					await this.plugin.saveSettings();
					new Notice('UGREEN sync history reset. Files were not deleted.');
					this.display();
				}),
			);
	}
}

function getVaultFolders(app: App): string[] {
	const folders = app.vault
		.getAllLoadedFiles()
		.filter((file): file is TFolder => file instanceof TFolder)
		.map((folder) => folder.path)
		.filter((path) => path !== '' && !path.startsWith(`${app.vault.configDir}/`))
		.sort();

	return ['/', ...folders];
}

function normalizeRemoteBaseDir(value: string): string {
	return normalizePath(value.trim()).replace(/^\/+|\/+$/g, '');
}
