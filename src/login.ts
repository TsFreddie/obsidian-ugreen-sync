import { App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import type { DropdownComponent } from 'obsidian';
import type { SessionContainer, UgosLoginResult } from 'ug-file';
import { debugLog } from './debug';
import { createUgreenClient, formatLoginResultError, formatUgreenError } from './ugreen';
import type { UgreenSyncSettings } from './types';
import { t } from './i18n';
import { makeModalKeyboardAware } from './mobile-keyboard';

type UgosLoginCodeRequiredResult = Extract<UgosLoginResult, { requiresCode: true }>;
type Protocol = 'ugreenlink' | 'https' | 'http';

export interface UgreenLoginModalResult {
	url: string;
	ugreenLinkId: string;
	username: string;
	session: SessionContainer;
}

interface UgreenLoginModalDraft extends UgreenLoginModalResult {
	password: string;
	protocol: Protocol;
	host: string;
}

export function openUgreenLoginModal(
	app: App,
	settings: UgreenSyncSettings,
): Promise<UgreenLoginModalResult | undefined> {
	return new Promise((resolve) => {
		new UgreenLoginModal(app, settings, resolve).open();
	});
}

class UgreenLoginModal extends Modal {
	private readonly resolve: (result: UgreenLoginModalResult | undefined) => void;
	private readonly settings: UgreenSyncSettings;
	private readonly draft: UgreenLoginModalDraft;
	private challenge?: UgosLoginCodeRequiredResult;
	private message = '';
	private otpCode = '';
	private busy = false;
	private resolved = false;

	constructor(
		app: App,
		settings: UgreenSyncSettings,
		resolve: (result: UgreenLoginModalResult | undefined) => void,
	) {
		super(app);
		this.resolve = resolve;
		this.settings = settings;
		const protocol = deriveProtocol(settings.url, settings.ugreenLinkId);
		this.draft = {
			url: settings.url,
			ugreenLinkId: settings.ugreenLinkId,
			username: settings.username,
			password: '',
			session: settings.session ?? {
				tokenId: '',
				token: '',
				uid: 0,
				publicKey: '',
				keepalive: true,
			},
			protocol,
			host: deriveHost(protocol, settings.url, settings.ugreenLinkId),
		};
	}

	onOpen(): void {
		debugLog(this.settings, 'login modal open', {
			hasSession: this.settings.session !== undefined,
			protocol: this.draft.protocol,
		});
		this.modalEl.classList.add('ugreen-sync-login-modal');
		makeModalKeyboardAware(this);
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			debugLog(this.settings, 'login modal dismissed');
			this.resolved = true;
			this.resolve(undefined);
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.setTitle(this.challenge === undefined ? t('login.title') : t('login.titleOtp'));

		if (this.draft.protocol === 'http') {
			this.contentEl.createEl('div', {
				text: t('login.httpWarning'),
				cls: 'ugreen-sync-login-http-warning',
			});
		}

		if (this.message !== '') {
			this.contentEl.createEl('p', {
				text: this.message,
				cls: 'ugreen-sync-login-message',
			});
		}

		if (this.challenge === undefined) {
			this.renderConnectionFields();
		} else {
			this.renderOtpFields();
		}
		this.renderActions();
	}

	private renderConnectionFields(): void {
		new Setting(this.contentEl)
			.setName(t('login.connectionType'))
			.setDesc(t('login.connectionTypeDesc'))
			.addDropdown((dropdown: DropdownComponent) =>
				dropdown
					.addOption('ugreenlink', t('login.protocolUgreenlink'))
					.addOption('https', t('login.protocolHttps'))
					.addOption('http', t('login.protocolHttp'))
					.setValue(this.draft.protocol)
					.onChange((value) => {
						this.draft.protocol = value as Protocol;
						this.render();
					}),
			);

		const isUgreenLink = this.draft.protocol === 'ugreenlink';
		new Setting(this.contentEl)
			.setName(isUgreenLink ? t('login.ugreenlinkId') : t('login.nasAddress'))
			.setDesc(isUgreenLink ? t('login.ugreenlinkIdDesc') : t('login.nasAddressDesc'))
			.addText((text) =>
				text
					.setPlaceholder(isUgreenLink ? t('login.ugreenlinkPlaceholder') : t('login.nasAddressPlaceholder'))
					.setValue(this.draft.host)
					.onChange((value) => {
						this.draft.host = value.trim();
					}),
			);

		new Setting(this.contentEl).setName(t('login.username')).addText((text) =>
			text.setValue(this.draft.username).onChange((value) => {
				this.draft.username = value;
			}),
		);

		new Setting(this.contentEl)
			.setName(t('login.password'))
			.setDesc(t('login.passwordDesc'))
			.addText((text) => {
				text.inputEl.type = 'password';
				text.onChange((value) => {
					this.draft.password = value;
				});
			});
	}

	private renderOtpFields(): void {
		new Setting(this.contentEl)
			.setName(t('login.authenticatorCode'))
			.setDesc(t('login.authCodeDesc'))
			.addText((text) =>
				text
					.setPlaceholder(t('login.authCodePlaceholder'))
					.setValue(this.otpCode)
					.onChange((value) => {
						this.otpCode = value.trim();
					}),
			);
	}

	private renderActions(): void {
		const actionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });

		new ButtonComponent(actionsEl)
			.setButtonText(this.challenge === undefined ? t('login.signIn') : t('login.verifyCode'))
			.setCta()
			.onClick(() => {
				void (this.challenge === undefined ? this.signIn() : this.verifyCode());
			});

		new ButtonComponent(actionsEl)
			.setButtonText(t('login.cancel'))
			.onClick(() => {
				if (this.busy) {
					return;
				}
				this.close();
			});
	}

	private async signIn(): Promise<void> {
		if (this.busy) {
			return;
		}

		const validationError = this.validateDraft();
		if (validationError !== undefined) {
			debugLog(this.settings, 'login validation failed', { message: validationError });
			this.message = validationError;
			this.render();
			return;
		}

		this.busy = true;
		this.message = t('login.signingIn');
		this.render();

		try {
			this.applyProtocol();
			debugLog(this.settings, 'login password submit', {
				protocol: this.draft.protocol,
				hasUsername: this.draft.username.trim() !== '',
				hasPassword: this.draft.password !== '',
			});
			const client = createUgreenClient(this.draft);
			const result = await client.login({
				username: this.draft.username,
				password: this.draft.password,
				keepalive: true,
			});
			if (result.success) {
				debugLog(this.settings, 'login password success', { uid: result.session.uid });
				this.finish(result.session);
				return;
			}
			if (result.requiresCode) {
				debugLog(this.settings, 'login otp required', {
					code: result.code,
					uid: result.challenge.uid,
				});
				this.challenge = result;
				this.message = '';
				return;
			}
			debugLog(this.settings, 'login password failed', {
				code: result.code,
				message: result.message,
			});
			this.message = formatLoginResultError(result);
		} catch (error) {
			debugLog(this.settings, 'login password error', { message: formatUgreenError(error) });
			this.message = formatUgreenError(error);
		} finally {
			this.busy = false;
			this.render();
		}
	}

	private async verifyCode(): Promise<void> {
		if (this.busy) {
			return;
		}

		if (this.challenge === undefined) {
			return;
		}
		if (this.otpCode === '') {
			debugLog(this.settings, 'login otp validation failed', { message: 'Authenticator code is required.' });
			this.message = t('login.authCodeRequired');
			this.render();
			return;
		}

		this.busy = true;
		this.message = t('login.verifyingCode');
		this.render();

		try {
			debugLog(this.settings, 'login otp submit');
			const result = await this.challenge.verifyCode(this.otpCode, false);
			if (result.success) {
				debugLog(this.settings, 'login otp success', { uid: result.session.uid });
				this.finish(result.session);
				return;
			}
			if (result.requiresCode) {
				debugLog(this.settings, 'login otp still required', {
					code: result.code,
					uid: result.challenge.uid,
				});
				this.challenge = result;
				this.message = t('login.enterNextCode');
				return;
			}
			debugLog(this.settings, 'login otp failed', {
				code: result.code,
				message: result.message,
			});
			this.message = result.message ?? t('login.authCodeFailed');
		} catch (error) {
			debugLog(this.settings, 'login otp error', { message: formatUgreenError(error) });
			this.message = formatUgreenError(error);
		} finally {
			this.busy = false;
			this.render();
		}
	}

	private finish(session: SessionContainer): void {
		debugLog(this.settings, 'login complete', { uid: session.uid });
		this.draft.session = session;
		this.resolved = true;
		this.resolve({
			url: this.draft.url,
			ugreenLinkId: this.draft.ugreenLinkId,
			username: this.draft.username,
			session: { ...session },
		});
		new Notice(t('notice.signInSucceeded'));
		this.close();
	}

	private applyProtocol(): void {
		if (this.draft.protocol === 'ugreenlink') {
			this.draft.url = '';
			this.draft.ugreenLinkId = this.draft.host;
		} else {
			this.draft.url = `${this.draft.protocol}://${this.draft.host}`;
			this.draft.ugreenLinkId = '';
		}
	}

	private validateDraft(): string | undefined {
		if (this.draft.host === '') {
			return this.draft.protocol === 'ugreenlink'
				? t('login.ugreenlinkIdRequired')
				: t('login.nasAddressRequired');
		}
		if (this.draft.username.trim() === '') {
			return t('login.usernameRequired');
		}
		if (this.draft.password === '') {
			return t('login.passwordRequired');
		}
		return undefined;
	}
}

function deriveProtocol(url: string, ugreenLinkId: string): Protocol {
	if (ugreenLinkId.trim() !== '') {
		return 'ugreenlink';
	}
	if (url.trim().toLowerCase().startsWith('http://')) {
		return 'http';
	}
	if (url.trim().toLowerCase().startsWith('https://')) {
		return 'https';
	}
	return 'ugreenlink';
}

function deriveHost(protocol: Protocol, url: string, ugreenLinkId: string): string {
	if (protocol === 'ugreenlink') {
		return ugreenLinkId;
	}
	return url.trim().replace(/^https?:\/\//i, '');
}
