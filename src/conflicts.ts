import { App, ButtonComponent, Component, MarkdownRenderer, Modal, Notice, Vault, normalizePath } from 'obsidian';
import { CONFLICTS_FOLDER } from './constants';
import { t } from './i18n';
import { makeModalKeyboardAware } from './mobile-keyboard';

type ConflictChoice = 'workspace' | 'conflict' | 'both';
type ConflictSide = 'workspace' | 'conflict';

export interface ConflictResolveResult {
	resolvedCount: number;
	keptBoth: boolean;
	syncAfterResolve: boolean;
}

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

export async function openConflictResolver(app: App, onResolved: (result: ConflictResolveResult) => void): Promise<void> {
	const conflicts = await getConflictFiles(app.vault);
	if (conflicts.length === 0) {
		new Notice(t('notice.noConflicts'));
		onResolved({ resolvedCount: 0, keptBoth: false, syncAfterResolve: false });
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
	return mtime === null ? t('conflicts.missing') : new Date(mtime).toLocaleString();
}

function formatSize(size: number | null): string {
	if (size === null) {
		return t('conflicts.missing');
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
		return t('conflicts.fileIsMissing');
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

function getDefaultPaneIndex(panes: [ConflictPane, ConflictPane], selectedChoice: ConflictChoice | undefined): number {
	if (selectedChoice === 'workspace' || selectedChoice === 'conflict') {
		return panes.findIndex((pane) => pane.side === selectedChoice);
	}

	const newerIndex = panes.findIndex((pane) => pane.title === 'Newer');
	return newerIndex === -1 ? 1 : newerIndex;
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
		this.setTitle(t('conflicts.title'));
		makeModalKeyboardAware(this);
		this.contentEl.empty();
		this.contentEl.createEl('p', {
			text: t('conflicts.conflictPromptLine1'),
		});
		this.contentEl.createEl('p', { text: t('conflicts.conflictPromptLine2') });

		const actionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		new ButtonComponent(actionsEl)
			.setButtonText(t('conflicts.cancelSync'))
			.onClick(() => {
				this.close();
			});
		new ButtonComponent(actionsEl)
			.setButtonText(t('conflicts.resolveNow'))
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
	private onResolved: (result: ConflictResolveResult) => void;
	private previewScrollLeft = 0;
	private previewScrollTop = 0;
	private renderToken = 0;

	constructor(app: App, conflicts: ConflictFile[], onResolved: (result: ConflictResolveResult) => void) {
		super(app);
		this.conflicts = conflicts;
		this.onResolved = onResolved;
	}

	onOpen(): void {
		this.modalEl.classList.add('ugreen-sync-conflict-modal');
		makeModalKeyboardAware(this);
		void this.renderCurrent();
	}

	onClose(): void {
		this.renderToken += 1;
		this.markdownComponent.unload();
	}

	private renderCurrent(): void {
		const renderToken = this.renderToken + 1;
		this.renderToken = renderToken;
		this.resetMarkdownComponent();
		const markdownComponent = this.markdownComponent;
		if (this.index >= this.conflicts.length) {
			this.renderConfirm();
			return;
		}

		const conflict = this.conflicts[this.index];
		if (conflict === undefined) {
			this.renderConfirm();
			return;
		}
		this.setTitle(t('conflicts.title'));
		this.contentEl.empty();
		this.contentEl.classList.add('ugreen-sync-conflict-content');
		this.renderFileHeader(conflict);

		const panes = getConflictPanes(conflict);
		const selectedChoice = this.decisions.get(conflict.conflictPath)?.choice;
		this.activePaneIndex = getDefaultPaneIndex(panes, selectedChoice);
		const tabsEl = this.renderPaneTabs(panes);
		const columnsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-conflict-columns' });
		const previewRenderTasks: Promise<void>[] = [];
		const previewEls = [
			this.renderPreview(columnsEl, conflict, panes[0], 0, selectedChoice, markdownComponent, renderToken, previewRenderTasks),
			this.renderPreview(columnsEl, conflict, panes[1], 1, selectedChoice, markdownComponent, renderToken, previewRenderTasks),
		].filter((previewEl): previewEl is HTMLElement => previewEl !== null);
		this.setActivePane(columnsEl, tabsEl, this.activePaneIndex);
		this.syncPaneTabs(tabsEl, columnsEl);
		this.syncPaneSwipe(columnsEl, tabsEl);
		this.syncPreviewScroll(previewEls);

		this.renderBothAction(conflict, selectedChoice);

		const secondaryActionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		new ButtonComponent(secondaryActionsEl)
			.setButtonText(t('conflicts.cancelResolve'))
			.onClick(() => {
				this.close();
			});
		const confirmSelectedButton = new ButtonComponent(secondaryActionsEl)
			.setButtonText(t('conflicts.confirmSelected'))
			.onClick(() => {
				this.renderConfirm();
			});
		confirmSelectedButton.buttonEl.classList.add('ugreen-sync-conflict-confirm-selected');
		confirmSelectedButton.buttonEl.disabled = this.decisions.size === 0;
		void Promise.all(previewRenderTasks).then(() => {
			if (renderToken !== this.renderToken || !columnsEl.isConnected) {
				return;
			}

			this.equalizePreviewScrollHeights(columnsEl, previewEls);
			this.applyActivePreviewScroll(columnsEl);
		});
	}

	private renderFileHeader(conflict: ConflictFile): void {
		const headerEl = this.contentEl.createDiv({ cls: 'ugreen-sync-conflict-file-header' });
		const previousButton = new ButtonComponent(headerEl)
			.setButtonText('‹')
			.onClick(() => {
				this.goToIndex(this.index - 1);
			});
		previousButton.buttonEl.setAttribute('aria-label', t('conflicts.previousConflict'));
		previousButton.buttonEl.setAttribute('title', t('conflicts.previousConflict'));
		previousButton.buttonEl.disabled = this.index === 0;

		headerEl.createEl('span', {
			text: t('conflicts.ofTotal', { index: String(this.index + 1), total: String(this.conflicts.length) }),
			cls: 'ugreen-sync-conflict-file-count',
		});

		const nextButton = new ButtonComponent(headerEl)
			.setButtonText('›')
			.onClick(() => {
				this.goToIndex(this.index + 1);
			});
		nextButton.buttonEl.setAttribute('aria-label', t('conflicts.nextConflict'));
		nextButton.buttonEl.setAttribute('title', t('conflicts.nextConflict'));
		nextButton.buttonEl.disabled = this.index >= this.conflicts.length - 1;

		this.contentEl.createEl('p', {
			text: conflict.originalPath,
			cls: 'ugreen-sync-conflict-file-label',
		});
	}

	private renderPreview(
		containerEl: HTMLElement,
		conflict: ConflictFile,
		pane: ConflictPane,
		paneIndex: number,
		selectedChoice: ConflictChoice | undefined,
		markdownComponent: Component,
		renderToken: number,
		previewRenderTasks: Promise<void>[],
	): HTMLElement | null {
		const side = pane.side;
		const path = side === 'workspace' ? conflict.originalPath : conflict.conflictPath;
		const mtime = side === 'workspace' ? conflict.workspaceMtime : conflict.conflictMtime;
		const size = side === 'workspace' ? conflict.workspaceSize : conflict.conflictSize;
		const isMarkdown = isMarkdownFile(conflict.originalPath);
		const columnEl = containerEl.createDiv({ cls: 'ugreen-sync-conflict-column' });
		columnEl.dataset.paneIndex = String(paneIndex);
		columnEl.dataset.side = side;
		columnEl.toggleClass('is-active', paneIndex === this.activePaneIndex);
		columnEl.toggleClass('is-choice-selected', selectedChoice === side);
		const headerEl = columnEl.createDiv({ cls: 'ugreen-sync-conflict-header' });
		headerEl.createEl('h3', { text: pane.title === 'Older' ? t('conflicts.older') : t('conflicts.newer') });
		if (side === 'workspace') {
			headerEl.createEl('span', { text: t('conflicts.inVault'), cls: 'ugreen-sync-conflict-badge' });
		}
		columnEl.createEl('p', { text: formatMtime(mtime), cls: 'ugreen-sync-conflict-time' });

		if (isMarkdown) {
			const previewEl = columnEl.createDiv({ cls: 'ugreen-sync-conflict-preview' });
			previewEl.classList.add('markdown-rendered');
			previewEl.createEl('p', { text: t('conflicts.loadingPreview'), cls: 'ugreen-sync-conflict-preview-loading' });
			this.renderPreviewActions(columnEl, conflict, side, selectedChoice);
			previewRenderTasks.push(this.renderMarkdownPreview(previewEl, path, conflict.originalPath, markdownComponent, renderToken));
			return previewEl;
		} else {
			columnEl.createEl('p', { text: formatSize(size) });
		}

		this.renderPreviewActions(columnEl, conflict, side, selectedChoice);
		return null;
	}

	private async renderMarkdownPreview(
		previewEl: HTMLElement,
		path: string,
		sourcePath: string,
		markdownComponent: Component,
		renderToken: number,
	): Promise<void> {
		let preview: string;
		try {
			preview = await readPreview(this.app.vault, path);
		} catch {
			if (renderToken === this.renderToken && previewEl.isConnected) {
				previewEl.setText(t('conflicts.unableToLoadPreview'));
			}
			return;
		}

		if (renderToken !== this.renderToken || !previewEl.isConnected) {
			return;
		}

		previewEl.empty();
		try {
			await MarkdownRenderer.render(this.app, preview, previewEl, sourcePath, markdownComponent);
		} catch {
			if (renderToken === this.renderToken && previewEl.isConnected) {
				previewEl.setText(t('conflicts.unableToRenderPreview'));
			}
			return;
		}
		if (renderToken !== this.renderToken || !previewEl.isConnected) {
			return;
		}

		previewEl.createDiv({ cls: 'ugreen-sync-conflict-preview-spacer' });
	}

	private renderPaneTabs(panes: [ConflictPane, ConflictPane]): HTMLElement {
		const tabsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-conflict-tabs' });
		tabsEl.setAttribute('role', 'tablist');
		panes.forEach((pane, index) => {
			const tabEl = tabsEl.createEl('button', {
				text: pane.title === 'Older' ? t('conflicts.older') : t('conflicts.newer'),
				cls: 'ugreen-sync-conflict-tab',
			});
			tabEl.type = 'button';
			tabEl.classList.toggle('is-active', index === this.activePaneIndex);
			tabEl.setAttribute('role', 'tab');
			tabEl.setAttribute('aria-selected', String(index === this.activePaneIndex));
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
		this.applyActivePreviewScroll(columnsEl);
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

	private renderPreviewActions(
		columnEl: HTMLElement,
		conflict: ConflictFile,
		side: ConflictSide,
		selectedChoice: ConflictChoice | undefined,
	): void {
		const actionsEl = columnEl.createDiv({ cls: 'ugreen-sync-modal-actions ugreen-sync-conflict-choice-row' });
		this.renderPreviewActionButton(actionsEl, conflict, side, selectedChoice);
	}

	private renderPreviewActionButton(
		actionsEl: HTMLElement,
		conflict: ConflictFile,
		side: ConflictSide,
		selectedChoice: ConflictChoice | undefined,
	): void {
		const button = new ButtonComponent(actionsEl)
			.setButtonText(selectedChoice === side ? t('conflicts.unselect') : t('conflicts.keepThisVersion'))
			.onClick(() => {
				this.choose(conflict, side);
			});
		if (selectedChoice === side) {
			button.setCta();
		}
		if (selectedChoice === side) {
			actionsEl.createEl('span', { text: t('conflicts.yourChoice'), cls: 'ugreen-sync-conflict-choice-lock' });
		}
	}

	private renderBothAction(conflict: ConflictFile, selectedChoice: ConflictChoice | undefined): void {
		const bothActionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions ugreen-sync-conflict-keep-both-row' });
		bothActionsEl.toggleClass('is-choice-selected', selectedChoice === 'both');
		this.renderBothActionButton(bothActionsEl, conflict, selectedChoice);
	}

	private renderBothActionButton(
		bothActionsEl: HTMLElement,
		conflict: ConflictFile,
		selectedChoice: ConflictChoice | undefined,
	): void {
		const button = new ButtonComponent(bothActionsEl)
			.setButtonText(selectedChoice === 'both' ? t('conflicts.unselectKeepBoth') : t('conflicts.keepBoth'))
			.onClick(() => {
				this.choose(conflict, 'both');
			});
		if (selectedChoice === 'both') {
			button.setCta();
		}
		if (selectedChoice === 'both') {
			bothActionsEl.createEl('span', { text: t('conflicts.yourChoice'), cls: 'ugreen-sync-conflict-choice-lock' });
		}
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
				this.previewScrollTop = sourceEl.scrollTop;
				this.previewScrollLeft = sourceEl.scrollLeft;
				for (const targetEl of previewEls) {
					if (targetEl === sourceEl) {
						continue;
					}

					targetEl.scrollTop = sourceEl.scrollTop;
					targetEl.scrollLeft = sourceEl.scrollLeft;
				}
				syncing = false;
			});
		}
	}

	private equalizePreviewScrollHeights(columnsEl: HTMLElement, previewEls: HTMLElement[]): void {
		if (previewEls.length < 2) {
			return;
		}

		columnsEl.classList.add('is-measuring');
		const scrollHeights = previewEls.map((previewEl) => previewEl.scrollHeight);
		const maxScrollHeight = Math.max(...scrollHeights);
		previewEls.forEach((previewEl, index) => {
			const scrollHeight = scrollHeights[index] ?? 0;
			const spacerEl = previewEl.querySelector<HTMLElement>('.ugreen-sync-conflict-preview-spacer');
			if (spacerEl === null) {
				return;
			}

			spacerEl.style.height = `${Math.max(0, maxScrollHeight - scrollHeight)}px`;
		});
		columnsEl.classList.remove('is-measuring');
	}

	private applyActivePreviewScroll(columnsEl: HTMLElement): void {
		const activePreviewEl = columnsEl.querySelector<HTMLElement>(
			'.ugreen-sync-conflict-column.is-active .ugreen-sync-conflict-preview',
		);
		if (activePreviewEl === null) {
			return;
		}

		activePreviewEl.scrollTop = this.previewScrollTop;
		activePreviewEl.scrollLeft = this.previewScrollLeft;
	}

	private resetMarkdownComponent(): void {
		this.markdownComponent.unload();
		this.markdownComponent = new Component();
		this.markdownComponent.load();
	}

	private choose(conflict: ConflictFile, choice: ConflictChoice): void {
		const currentConflict = this.conflicts[this.index];
		const isCurrentConflict = currentConflict?.conflictPath === conflict.conflictPath;
		if (this.decisions.get(conflict.conflictPath)?.choice === choice) {
			this.decisions.delete(conflict.conflictPath);
			if (isCurrentConflict) {
				this.updateSelectionState(conflict);
				return;
			}

			this.renderCurrent();
			return;
		}

		this.decisions.set(conflict.conflictPath, { conflict, choice });
		if (isCurrentConflict) {
			this.updateSelectionState(conflict);
			this.index += 1;
			this.renderCurrent();
			return;
		}

		this.renderCurrent();
	}

	private updateSelectionState(conflict: ConflictFile): void {
		const selectedChoice = this.decisions.get(conflict.conflictPath)?.choice;
		this.contentEl.querySelectorAll<HTMLElement>('.ugreen-sync-conflict-column').forEach((columnEl) => {
			const side = columnEl.dataset.side as ConflictSide | undefined;
			if (side === undefined) {
				return;
			}

			columnEl.toggleClass('is-choice-selected', selectedChoice === side);
			const actionsEl = columnEl.querySelector<HTMLElement>('.ugreen-sync-conflict-choice-row');
			if (actionsEl === null) {
				return;
			}

			actionsEl.empty();
			this.renderPreviewActionButton(actionsEl, conflict, side, selectedChoice);
		});

		const bothActionsEl = this.contentEl.querySelector<HTMLElement>('.ugreen-sync-conflict-keep-both-row');
		if (bothActionsEl !== null) {
			bothActionsEl.toggleClass('is-choice-selected', selectedChoice === 'both');
			bothActionsEl.empty();
			this.renderBothActionButton(bothActionsEl, conflict, selectedChoice);
		}

		const confirmSelectedButton = this.contentEl.querySelector<HTMLButtonElement>('.ugreen-sync-conflict-confirm-selected');
		if (confirmSelectedButton !== null) {
			confirmSelectedButton.disabled = this.decisions.size === 0;
		}
	}

	private goToIndex(index: number): void {
		this.activePaneIndex = 1;
		this.previewScrollLeft = 0;
		this.previewScrollTop = 0;
		this.index = Math.max(0, Math.min(index, this.conflicts.length - 1));
		void this.renderCurrent();
	}

	private renderConfirm(): void {
		this.resetMarkdownComponent();
		const decisions = [...this.decisions.values()];
		const counts = getDecisionCounts(decisions);
		this.setTitle(t('conflicts.confirmTitle'));
		this.contentEl.empty();
		this.contentEl.classList.remove('ugreen-sync-conflict-content');
		const backActionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		const backButton = new ButtonComponent(backActionsEl)
			.setButtonText('‹')
			.onClick(() => {
				this.index = Math.min(this.decisions.size, this.conflicts.length - 1);
				void this.renderCurrent();
			});
		backButton.buttonEl.setAttribute('aria-label', t('conflicts.backToResolver'));
		backButton.buttonEl.setAttribute('title', t('conflicts.backToResolver'));
		this.contentEl.createEl('p', {
			text: t('conflicts.conflictFilesSelected', { decisions: String(decisions.length), total: String(this.conflicts.length) }),
		});
		this.contentEl.createEl('p', { text: t('conflicts.olderVersionsSelected', { count: String(counts.older) }) });
		this.contentEl.createEl('p', { text: t('conflicts.newerVersionsSelected', { count: String(counts.newer) }) });
		this.contentEl.createEl('p', { text: t('conflicts.keepBothSelected', { count: String(counts.both) }) });
		const resolveAndSyncDisabledReason = getResolveAndSyncDisabledReason(decisions.length, this.conflicts.length, counts.both);
		if (resolveAndSyncDisabledReason !== undefined) {
			this.contentEl.createEl('p', {
				text: resolveAndSyncDisabledReason,
				cls: 'ugreen-sync-conflict-sync-banner',
			});
		}
		if (decisions.length < this.conflicts.length) {
			this.contentEl.createEl('p', {
				text: t('conflicts.remainingUnresolved', { count: String(this.conflicts.length - decisions.length) }),
			});
		}

		const actionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });
		new ButtonComponent(actionsEl)
			.setButtonText(t('conflicts.cancelResolve'))
			.onClick(() => {
				this.close();
			});
		const resolveButton = new ButtonComponent(actionsEl)
			.setButtonText(t('conflicts.resolve'))
			.onClick(async () => {
				await this.resolve(decisions, false);
			});
		resolveButton.buttonEl.disabled = decisions.length === 0;
		const resolveAndSyncButton = new ButtonComponent(actionsEl)
			.setButtonText(t('conflicts.resolveAndSync'))
			.setCta()
			.onClick(async () => {
				await this.resolve(decisions, true);
			});
		resolveAndSyncButton.buttonEl.disabled = resolveAndSyncDisabledReason !== undefined;
	}

	private async resolve(decisions: ConflictDecision[], syncAfterResolve: boolean): Promise<void> {
		const counts = getDecisionCounts(decisions);
		await applyDecisions(this.app.vault, decisions);
		new Notice(t('notice.conflictsResolved', { count: String(decisions.length) }));
		this.onResolved({
			resolvedCount: decisions.length,
			keptBoth: counts.both > 0,
			syncAfterResolve,
		});
		this.close();
	}
}

function getResolveAndSyncDisabledReason(selectedCount: number, totalCount: number, keepBothCount: number): string | undefined {
	if (selectedCount < totalCount) {
		return t('conflicts.resolveAndSyncIncomplete');
	}

	if (keepBothCount > 0) {
		return t('conflicts.resolveAndSyncKeepBoth');
	}

	return undefined;
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
