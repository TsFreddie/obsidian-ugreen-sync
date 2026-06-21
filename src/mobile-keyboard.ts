import { Platform } from 'obsidian';

interface KeyboardAwareModal {
	modalEl: HTMLElement;
	contentEl: HTMLElement;
}

export function makeModalKeyboardAware(modal: KeyboardAwareModal): void {
	if (!Platform.isMobile) {
		return;
	}

	const rootEl = modal.modalEl.doc.documentElement;

	const updateOffset = () => {
		const keyboardHeight = parseFloat(
			rootEl.style.getPropertyValue('--keyboard-height') || '0',
		);
		modal.contentEl.style.paddingBottom = keyboardHeight > 0
			? `${keyboardHeight}px`
			: '';
	};

	const observer = new MutationObserver(updateOffset);
	observer.observe(rootEl, {
		attributes: true,
		attributeFilter: ['style'],
	});
	updateOffset();
}
