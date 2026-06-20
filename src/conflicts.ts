import { App, ButtonComponent, Component, MarkdownRenderer, Modal, Notice, Vault, normalizePath } from 'obsidian';
import { CONFLICTS_FOLDER } from './constants';

type ConflictChoice = 'workspace' | 'conflict' | 'both';
type ConflictSide = 'workspace' | 'conflict';

interface ConflictFile {
	originalPath: string;
	conflictPath: string;
	workspaceMtime: number | null;
	conflictMtime: number;
	workspaceSize: number | null;
	conflictSize: number;
}

interface ConflictDecision {
	conflict: ConflictFile;
	choice: ConflictChoice;
}

interface ConflictPane {
	title: 'Older' | 'Newer';
	side: ConflictSide;
}

export async function hasUnresolvedConflicts(vault: Vault): Promise<boolean> {
	return (await getConflictFiles(vault)).length > 0;
}

export async function getConflictFiles(vault: Vault): Promise<ConflictFile[]> {
	if (!(await vault.adapter.exists(CONFLICTS_FOLDER))) {
		return [];
	}

	const conflictPaths = await listConflictPaths(vault, CONFLICTS_FOLDER);
	const conflicts: ConflictFile[] = [];
	for (const conflictPath of conflictPaths.sort()) {
		const conflictStat = await vault.adapter.stat(conflictPath);
		if (conflictStat?.type !== 'file') {
			continue;
		}

		const originalPath = getOriginalPath(conflictPath);
		if (originalPath === null) {
			continue;
		}

		const workspaceStat = await vault.adapter.stat(originalPath);
		conflicts.push({
			originalPath,
			conflictPath,
			workspaceMtime: workspaceStat?.type === 'file' ? workspaceStat.mtime : null,
			conflictMtime: conflictStat.mtime,
			workspaceSize: workspaceStat?.type === 'file' ? workspaceStat.size : null,
			conflictSize: conflictStat.size,
		});
	}

	return conflicts;
}

export function openConflictPrompt(app: App, onResolve: () => void): void {
	new ConflictPromptModal(app, onResolve).open();
}

export async function openConflictResolver(app: App, onResolved: () => void): Promise<void> {
	const conflicts = await getConflictFiles(app.vault);
	if (conflicts.length === 0) {
		new Notice('No unresolved ugreen sync conflicts found.');
		onResolved();
		return;
	}

	new ConflictResolverModal(app, conflicts, onResolved).open();
}

async function listConflictPaths(vault: Vault, folderPath: string): Promise<string[]> {
	const listed = await vault.adapter.list(folderPath);
	const nestedFiles = await Promise.all(
		listed.folders.map((path) => listConflictPaths(vault, path)),
	);
	return [...listed.files, ...nestedFiles.flat()];
}

function getOriginalPath(conflictPath: string): string | null {
	const relativePath = normalizePath(conflictPath).slice(`${CONFLICTS_FOLDER}/`.length);
	const lastSlash = relativePath.lastIndexOf('/');
	const directory = lastSlash === -1 ? '' : relativePath.slice(0, lastSlash + 1);
	const filename = lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1);
	const originalFilename = filename.replace(/\.conflict-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?=\.[^.]|$)/, '');

	if (originalFilename === filename) {
		return null;
	}

	return `${directory}${originalFilename}`;
}

function formatMtime(mtime: number | null): string {
	return mtime === null ? 'Missing' : new Date(mtime).toLocaleString();
}

function formatSize(size: number | null): string {
	if (size === null) {
		return 'Missing';
	}

	if (size < 1024) {
		return `${size} B`;
	}

	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}

	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isMarkdownFile(path: string): boolean {
	return /\.md$/i.test(path);
}

async function readPreview(vault: Vault, path: string): Promise<string> {
	if (!(await vault.adapter.exists(path))) {
		return 'File is missing.';
	}

	const content = await vault.adapter.read(path);
	return content.length > 12000 ? `${content.slice(0, 12000)}\n...` : content;
}

async function applyDecisions(vault: Vault, decisions: ConflictDecision[]): Promise<void> {
	for (const decision of decisions) {
		if (decision.choice === 'conflict') {
			await writeConflictToPath(vault, decision.conflict, decision.conflict.originalPath);
		}

		if (decision.choice === 'both') {
			const copyPath = await getAvailableBothPath(vault, decision.conflict.originalPath);
			await writeConflictToPath(vault, decision.conflict, copyPath);
		}

		await vault.adapter.remove(decision.conflict.conflictPath);
	}

	const remaining = await getConflictFiles(vault);
	if (remaining.length === 0 && (await vault.adapter.exists(CONFLICTS_FOLDER))) {
		await vault.adapter.rmdir(CONFLICTS_FOLDER, true);
	}
}

async function writeConflictToPath(vault: Vault, conflict: ConflictFile, targetPath: string): Promise<void> {
	await ensureParentFolder(vault, targetPath);
	const content = await vault.adapter.readBinary(conflict.conflictPath);
	await vault.adapter.writeBinary(targetPath, content, { mtime: conflict.conflictMtime });
}

async function getAvailableBothPath(vault: Vault, originalPath: string): Promise<string> {
	const lastSlash = originalPath.lastIndexOf('/');
	const directory = lastSlash === -1 ? '' : originalPath.slice(0, lastSlash + 1);
	const filename = lastSlash === -1 ? originalPath : originalPath.slice(lastSlash + 1);
	const lastDot = filename.lastIndexOf('.');
	const base = lastDot <= 0 ? filename : filename.slice(0, lastDot);
	const extension = lastDot <= 0 ? '' : filename.slice(lastDot);
	let candidate = `${directory}${base}.conflict-copy${extension}`;
	let index = 2;

	while (await vault.adapter.exists(candidate)) {
		candidate = `${directory}${base}.conflict-copy-${index}${extension}`;
		index += 1;
	}

	return candidate;
}

function getConflictPanes(conflict: ConflictFile): [ConflictPane, ConflictPane] {
	const workspaceIsOlder = conflict.workspaceMtime === null || conflict.workspaceMtime <= conflict.conflictMtime;
	const workspacePane: ConflictPane = {
		title: workspaceIsOlder ? 'Older' : 'Newer',
		side: 'workspace',
	};
	const conflictPane: ConflictPane = {
		title: workspaceIsOlder ? 'Newer' : 'Older',
		side: 'conflict',
	};

	return workspaceIsOlder ? [workspacePane, conflictPane] : [conflictPane, workspacePane];
}

async function ensureParentFolder(vault: Vault, path: string): Promise<void> {
	const parts = path.split('/');
	parts.pop();
	let current = '';
	for (const part of parts) {
		current = current === '' ? part : `${current}/${part}`;
		if (!(await vault.adapter.exists(current))) {
			await vault.adapter.mkdir(current);
		}
	}
}

class ConflictPromptModal extends Modal {
	private onResolve: () => void;

	constructor(app: App, onResolve: () => void) {
		super(app);
		this.onResolve = onResolve;
	}

	onOpen(): void {
		this.setTitle('Resolve sync conflicts');
		this.contentEl.empty();
		this.contentEl.createEl('p', {
			text: 'Ugreen sync can not proceed while files remain in .conflicts.',
		});
		this.contentEl.createEl('p', { text: 'Resolve them now?' });

		const actionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		new ButtonComponent(actionsEl)
			.setButtonText('Cancel sync')
			.onClick(() => {
				this.close();
			});
		new ButtonComponent(actionsEl)
			.setButtonText('Resolve now')
			.setCta()
			.onClick(() => {
				this.close();
				this.onResolve();
			});
	}
}

class ConflictResolverModal extends Modal {
	private conflicts: ConflictFile[];
	private decisions = new Map<string, ConflictDecision>();
	private activePaneIndex = 1;
	private index = 0;
	private markdownComponent = new Component();
	private onResolved: () => void;

	constructor(app: App, conflicts: ConflictFile[], onResolved: () => void) {
		super(app);
		this.conflicts = conflicts;
		this.onResolved = onResolved;
	}

	onOpen(): void {
		this.modalEl.classList.add('ugreen-sync-conflict-modal');
		void this.renderCurrent();
	}

	onClose(): void {
		this.markdownComponent.unload();
	}

	private async renderCurrent(): Promise<void> {
		this.resetMarkdownComponent();
		if (this.index >= this.conflicts.length) {
			this.renderConfirm();
			return;
		}

		const conflict = this.conflicts[this.index];
		if (conflict === undefined) {
			this.renderConfirm();
			return;
		}
		this.setTitle('Resolve sync conflicts');
		this.contentEl.empty();
		this.contentEl.classList.add('ugreen-sync-conflict-content');
		this.contentEl.createEl('p', {
			text: `${this.index + 1} of ${this.conflicts.length}: ${conflict.originalPath}`,
			cls: 'ugreen-sync-conflict-file-label',
		});

		const panes = getConflictPanes(conflict);
		const tabsEl = this.renderPaneTabs(panes);
		const columnsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-conflict-columns' });
		const previewEls = [
			await this.renderPreview(columnsEl, conflict, panes[0], 0),
			await this.renderPreview(columnsEl, conflict, panes[1], 1),
		].filter((previewEl): previewEl is HTMLElement => previewEl !== null);
		this.setActivePane(columnsEl, tabsEl, this.activePaneIndex);
		this.syncPaneTabs(tabsEl, columnsEl);
		this.syncPaneSwipe(columnsEl, tabsEl);
		this.syncPreviewScroll(previewEls);

		const bothActionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		new ButtonComponent(bothActionsEl)
			.setButtonText('Keep both versions')
			.onClick(() => {
				this.choose(conflict, 'both');
			});

		const secondaryActionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		new ButtonComponent(secondaryActionsEl)
			.setButtonText('Cancel resolve')
			.onClick(() => {
				this.close();
			});
		const confirmSelectedButton = new ButtonComponent(secondaryActionsEl)
			.setButtonText('Confirm selected')
			.onClick(() => {
				this.renderConfirm();
			});
		confirmSelectedButton.buttonEl.disabled = this.decisions.size === 0;
	}

	private async renderPreview(
		containerEl: HTMLElement,
		conflict: ConflictFile,
		pane: ConflictPane,
		paneIndex: number,
	): Promise<HTMLElement | null> {
		const side = pane.side;
		const path = side === 'workspace' ? conflict.originalPath : conflict.conflictPath;
		const mtime = side === 'workspace' ? conflict.workspaceMtime : conflict.conflictMtime;
		const size = side === 'workspace' ? conflict.workspaceSize : conflict.conflictSize;
		const isMarkdown = isMarkdownFile(conflict.originalPath);
		const columnEl = containerEl.createDiv({ cls: 'ugreen-sync-conflict-column' });
		columnEl.dataset.paneIndex = String(paneIndex);
		const headerEl = columnEl.createDiv({ cls: 'ugreen-sync-conflict-header' });
		headerEl.createEl('h3', { text: pane.title });
		if (side === 'workspace') {
			headerEl.createEl('span', { text: 'In vault', cls: 'ugreen-sync-conflict-badge' });
		}
		columnEl.createEl('p', { text: formatMtime(mtime), cls: 'ugreen-sync-conflict-time' });

		if (isMarkdown) {
			const preview = await readPreview(this.app.vault, path);
			const previewEl = columnEl.createDiv({ cls: 'ugreen-sync-conflict-preview' });
			previewEl.classList.add('markdown-rendered');
			await MarkdownRenderer.render(this.app, preview, previewEl, conflict.originalPath, this.markdownComponent);
			this.renderPreviewActions(columnEl, conflict, side);
			return previewEl;
		} else {
			columnEl.createEl('p', { text: formatSize(size) });
		}

		this.renderPreviewActions(columnEl, conflict, side);
		return null;
	}

	private renderPaneTabs(panes: [ConflictPane, ConflictPane]): HTMLElement {
		const tabsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-conflict-tabs' });
		tabsEl.setAttribute('role', 'tablist');
		panes.forEach((pane, index) => {
			const tabEl = tabsEl.createEl('button', {
				text: pane.title,
				cls: 'ugreen-sync-conflict-tab',
			});
			tabEl.type = 'button';
			tabEl.setAttribute('role', 'tab');
			tabEl.dataset.paneIndex = String(index);
		});
		return tabsEl;
	}

	private setActivePane(columnsEl: HTMLElement, tabsEl: HTMLElement, index: number): void {
		this.activePaneIndex = Math.max(0, Math.min(index, 1));
		columnsEl.querySelectorAll<HTMLElement>('.ugreen-sync-conflict-column').forEach((columnEl, columnIndex) => {
			columnEl.classList.toggle('is-active', columnIndex === this.activePaneIndex);
		});
		tabsEl.querySelectorAll<HTMLButtonElement>('.ugreen-sync-conflict-tab').forEach((tabEl, tabIndex) => {
			tabEl.classList.toggle('is-active', tabIndex === this.activePaneIndex);
			tabEl.setAttribute('aria-selected', String(tabIndex === this.activePaneIndex));
		});
	}

	private syncPaneTabs(tabsEl: HTMLElement, columnsEl: HTMLElement): void {
		tabsEl.addEventListener('click', () => {
			this.setActivePane(columnsEl, tabsEl, this.activePaneIndex === 0 ? 1 : 0);
		});
	}

	private syncPaneSwipe(columnsEl: HTMLElement, tabsEl: HTMLElement): void {
		let startX: number | null = null;
		let startY: number | null = null;
		columnsEl.addEventListener('touchstart', (event) => {
			const touch = event.touches.item(0);
			if (touch === null) {
				return;
			}
			startX = touch.clientX;
			startY = touch.clientY;
		}, { passive: true });
		columnsEl.addEventListener('touchend', (event) => {
			const touch = event.changedTouches.item(0);
			if (touch === null || startX === null || startY === null) {
				return;
			}

			const deltaX = touch.clientX - startX;
			const deltaY = touch.clientY - startY;
			startX = null;
			startY = null;
			if (Math.abs(deltaX) < 50 || Math.abs(deltaX) < Math.abs(deltaY)) {
				return;
			}

			this.setActivePane(columnsEl, tabsEl, this.activePaneIndex + (deltaX < 0 ? 1 : -1));
		}, { passive: true });
	}

	private renderPreviewActions(columnEl: HTMLElement, conflict: ConflictFile, side: ConflictSide): void {
		const actionsEl = columnEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		new ButtonComponent(actionsEl)
			.setButtonText('Keep this version')
			.setCta()
			.onClick(() => {
				this.choose(conflict, side);
			});
	}

	private syncPreviewScroll(previewEls: HTMLElement[]): void {
		if (previewEls.length < 2) {
			return;
		}

		let syncing = false;
		for (const sourceEl of previewEls) {
			sourceEl.addEventListener('scroll', () => {
				if (syncing) {
					return;
				}

				syncing = true;
				const sourceMaxTop = sourceEl.scrollHeight - sourceEl.clientHeight;
				const topRatio = sourceMaxTop <= 0 ? 0 : sourceEl.scrollTop / sourceMaxTop;
				for (const targetEl of previewEls) {
					if (targetEl === sourceEl) {
						continue;
					}

					const targetMaxTop = targetEl.scrollHeight - targetEl.clientHeight;
					targetEl.scrollTop = targetMaxTop * topRatio;
					targetEl.scrollLeft = sourceEl.scrollLeft;
				}
				syncing = false;
			});
		}
	}

	private resetMarkdownComponent(): void {
		this.markdownComponent.unload();
		this.markdownComponent = new Component();
		this.markdownComponent.load();
	}

	private choose(conflict: ConflictFile, choice: ConflictChoice): void {
		this.decisions.set(conflict.conflictPath, { conflict, choice });
		this.activePaneIndex = 1;
		this.index += 1;
		void this.renderCurrent();
	}

	private renderConfirm(): void {
		this.resetMarkdownComponent();
		const decisions = [...this.decisions.values()];
		const counts = getDecisionCounts(decisions);
		this.setTitle('Confirm conflict resolution');
		this.contentEl.empty();
		this.contentEl.classList.remove('ugreen-sync-conflict-content');
		this.contentEl.createEl('p', {
			text: `${decisions.length} of ${this.conflicts.length} conflict files selected.`,
		});
		this.contentEl.createEl('p', { text: `${counts.older} older versions selected.` });
		this.contentEl.createEl('p', { text: `${counts.newer} newer versions selected.` });
		this.contentEl.createEl('p', { text: `${counts.both} files selected to keep both versions.` });
		if (decisions.length < this.conflicts.length) {
			this.contentEl.createEl('p', {
				text: `${this.conflicts.length - decisions.length} conflict files will remain unresolved.`,
			});
		}

		const actionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		new ButtonComponent(actionsEl)
			.setButtonText('Back')
			.onClick(() => {
				this.index = Math.min(this.decisions.size, this.conflicts.length - 1);
				void this.renderCurrent();
			});
		new ButtonComponent(actionsEl)
			.setButtonText('Cancel resolve')
			.onClick(() => {
				this.close();
			});
		const confirmButton = new ButtonComponent(actionsEl)
			.setButtonText('Confirm resolve')
			.setCta()
			.onClick(async () => {
				await applyDecisions(this.app.vault, decisions);
				new Notice(`Resolved ${decisions.length} ugreen sync conflict files.`);
				this.onResolved();
				this.close();
			});
		confirmButton.buttonEl.disabled = decisions.length === 0;
	}
}

function getDecisionCounts(decisions: ConflictDecision[]): { older: number; newer: number; both: number } {
	let older = 0;
	let newer = 0;
	let both = 0;

	for (const decision of decisions) {
		if (decision.choice === 'both') {
			both += 1;
		}

		if (decision.choice === 'both' || decision.choice === 'conflict') {
			if (decision.conflict.workspaceMtime !== null && decision.conflict.conflictMtime < decision.conflict.workspaceMtime) {
				older += 1;
			} else {
				newer += 1;
			}
			continue;
		}

		if (decision.conflict.workspaceMtime === null || decision.conflict.workspaceMtime > decision.conflict.conflictMtime) {
			newer += 1;
		} else {
			older += 1;
		}
	}

	return { older, newer, both };
}
