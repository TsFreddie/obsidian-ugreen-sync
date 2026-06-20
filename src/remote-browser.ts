import { App, Modal, Setting, normalizePath } from 'obsidian';
import type { UgosClient, UgosDirent } from 'ug-file';
import { t } from './i18n';

const DIRECTORY_PAGE_LIMIT = 2000;

interface RemoteDirectoryPickerOptions {
	client: UgosClient;
	initialPath: string;
	vaultName: string;
	onChoose: (path: string) => void | Promise<void>;
}

export class RemoteDirectoryPickerModal extends Modal {
	private readonly client: UgosClient;
	private readonly vaultName: string;
	private readonly onChoose: (path: string) => void | Promise<void>;
	private currentPath = '';
	private addVaultName: boolean;
	private selectedPathEl!: HTMLElement;
	private listingEl!: HTMLElement;
	private chooseButtonEl?: HTMLButtonElement;
	private directoryLoadId = 0;
	private rootPaths = new Set<string>();

	constructor(app: App, options: RemoteDirectoryPickerOptions) {
		super(app);
		this.client = options.client;
		this.vaultName = normalizePathSegment(options.vaultName);
		this.onChoose = options.onChoose;
		this.addVaultName = true;
	}

	onOpen(): void {
		this.modalEl.addClass('ugreen-sync-browser-modal');
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.setTitle(t('browser.title'));

		this.selectedPathEl = this.contentEl.createDiv({ cls: 'ugreen-sync-browser-path' });
		this.updateSelectedPath();

		new Setting(this.contentEl)
			.setName(t('browser.addVaultName'))
			.setDesc(t('browser.addVaultNameDesc', { vaultName: this.vaultName }))
			.addToggle((toggle) => {
				toggle.setValue(this.addVaultName).onChange((value) => {
					this.addVaultName = value;
					this.updateSelectedPath();
				});
			});

		const navigationEl = this.contentEl.createDiv({ cls: 'ugreen-sync-browser-navigation' });
		const backButtonEl = navigationEl.createEl('button', { text: t('browser.back') });
		backButtonEl.disabled = this.currentPath === '';
		backButtonEl.addEventListener('click', () => {
			this.currentPath = this.rootPaths.has(this.currentPath) ? '' : getParentPath(this.currentPath);
			this.render();
		});
		navigationEl.createSpan({
			cls: 'ugreen-sync-browser-current-path',
			text: this.currentPath === '' ? t('browser.nasRoots') : this.currentPath,
		});

		this.listingEl = this.contentEl.createDiv({ cls: 'ugreen-sync-browser-listing' });

		const actionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		this.chooseButtonEl = actionsEl.createEl('button', { text: t('browser.useThisFolder') });
		this.chooseButtonEl.addClass('mod-cta');
		this.chooseButtonEl.disabled = this.currentPath === '';
		this.chooseButtonEl.addEventListener('click', () => {
			void this.chooseCurrentPath();
		});
		const cancelButtonEl = actionsEl.createEl('button', { text: t('browser.cancel') });
		cancelButtonEl.addEventListener('click', () => this.close());

		void this.loadDirectoryEntries();
	}

	private async loadDirectoryEntries(): Promise<void> {
		const loadId = ++this.directoryLoadId;
		this.setListingStatus(t('browser.loadingFolders'));

		try {
			const directories = await this.listDirectories(this.currentPath);
			if (loadId !== this.directoryLoadId || !this.listingEl.isConnected) {
				return;
			}
			if (directories.length === 0) {
				this.setListingStatus(t('browser.noFolders'));
				return;
			}
			this.renderDirectoryEntries(directories);
		} catch (error) {
			if (loadId === this.directoryLoadId && this.listingEl.isConnected) {
				this.setListingStatus(t('browser.listError', { error: formatError(error) }));
			}
		}
	}

	private async listDirectories(path: string): Promise<UgosDirent[]> {
		if (path === '') {
			const root = await this.client.root();
			const directories = sortDirectories([...root.personal, ...root.shared]);
			this.rootPaths = new Set(directories.map((directory) => normalizeRemotePath(directory.path)));
			return directories;
		}

		const directories: UgosDirent[] = [];
		let page = 1;
		while (true) {
			const entries = await this.client.list(path, { page, limit: DIRECTORY_PAGE_LIMIT });
			directories.push(...entries.filter((entry) => entry.isDirectory()));
			if (entries.length < DIRECTORY_PAGE_LIMIT) {
				break;
			}
			page += 1;
		}
		return sortDirectories(directories);
	}

	private renderDirectoryEntries(directories: UgosDirent[]): void {
		this.listingEl.empty();
		for (const directory of directories) {
			const buttonEl = this.listingEl.createEl('button', {
				cls: 'ugreen-sync-browser-entry',
				text: this.currentPath === '' ? getRootDirectoryLabel(directory) : directory.name,
			});
			buttonEl.addEventListener('click', () => {
				this.currentPath = normalizeRemotePath(directory.path);
				this.render();
			});
		}
	}

	private async chooseCurrentPath(): Promise<void> {
		const selectedPath = this.getSelectedPath();
		if (selectedPath === '') {
			this.setListingStatus(t('browser.chooseFolderFirst'));
			return;
		}

		if (this.chooseButtonEl !== undefined) {
			this.chooseButtonEl.disabled = true;
		}
		await this.onChoose(selectedPath);
		this.close();
	}

	private updateSelectedPath(): void {
		const selectedPath = this.getSelectedPath();
		this.selectedPathEl.setText(
			selectedPath === '' ? t('browser.chooseFolderPrompt') : t('browser.selectedPath', { path: selectedPath }),
		);
	}

	private getSelectedPath(): string {
		if (this.currentPath === '') {
			return '';
		}
		const selectedPath = this.addVaultName
			? `${this.currentPath}/${this.vaultName}`
			: this.currentPath;
		return normalizeRemotePath(selectedPath);
	}

	private setListingStatus(message: string): void {
		this.listingEl.empty();
		this.listingEl.createDiv({ cls: 'ugreen-sync-browser-status', text: message });
	}
}

function sortDirectories(directories: UgosDirent[]): UgosDirent[] {
	return directories.sort((first, second) => first.name.localeCompare(second.name));
}

function getParentPath(path: string): string {
	const normalizedPath = normalizeRemotePath(path);
	const lastSlashIndex = normalizedPath.lastIndexOf('/');
	return lastSlashIndex <= 0 ? '' : normalizedPath.slice(0, lastSlashIndex);
}

function getRootDirectoryLabel(directory: UgosDirent): string {
	const path = normalizeRemotePath(directory.path);
	return path === '' ? directory.name : path;
}

function normalizeRemotePath(path: string): string {
	const cleanPath = normalizePath(path.trim()).replace(/^\/+|\/+$/g, '');
	return cleanPath === '' ? '' : `/${cleanPath}`;
}

function normalizePathSegment(path: string): string {
	return normalizePath(path.trim()).replace(/^\/+|\/+$/g, '');
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
