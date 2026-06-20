import { App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import type { SessionContainer, UgosLoginResult } from 'ug-file';
import { debugLog } from './debug';
import { createUgreenClient, formatLoginResultError, formatUgreenError } from './ugreen';
import type { UgreenSyncSettings } from './types';

type UgosLoginCodeRequiredResult = Extract<UgosLoginResult, { requiresCode: true }>;

export interface UgreenLoginModalResult {
	url: string;
	ugreenLinkId: string;
	username: string;
	session: SessionContainer;
}

interface UgreenLoginModalDraft extends UgreenLoginModalResult {
	password: string;
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
			},
		};
	}

	onOpen(): void {
		debugLog(this.settings, 'login modal open', {
			hasSession: this.settings.session !== undefined,
			mode: this.draft.url.trim() !== '' ? 'url' : 'ugreenlink',
		});
		this.modalEl.classList.add('ugreen-sync-login-modal');
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
		this.setTitle(this.challenge === undefined ? 'Sign in to UGREEN NAS' : 'Enter authenticator code');

		this.contentEl.createEl('p', {
			text:
				this.challenge === undefined
					? 'Sign in before syncing. If UGOS requires OTP, enter the authenticator code without leaving Obsidian.'
					: 'Enter the current code from your authenticator app to finish signing in.',
			cls: 'ugreen-sync-login-intro',
		});

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
			.setName('NAS address')
			.setDesc('Direct UGOS URL. Leave blank when using UGREENlink ID.')
			.addText((text) =>
				text
					.setPlaceholder('https://your-nas.example.com')
					.setValue(this.draft.url)
					.onChange((value) => {
						this.draft.url = value.trim();
					}),
			);

		new Setting(this.contentEl)
			.setName('UGREENlink ID')
			.setDesc('Alternative to direct NAS address.')
			.addText((text) =>
				text
					.setPlaceholder('Your UGREENlink ID')
					.setValue(this.draft.ugreenLinkId)
					.onChange((value) => {
						this.draft.ugreenLinkId = value.trim();
					}),
			);

		new Setting(this.contentEl).setName('Username').addText((text) =>
			text.setValue(this.draft.username).onChange((value) => {
				this.draft.username = value;
			}),
		);

		new Setting(this.contentEl)
			.setName('Password')
			.setDesc('Used only for this sign-in and not saved by the plugin.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text.onChange((value) => {
					this.draft.password = value;
				});
			});
	}

	private renderOtpFields(): void {
		new Setting(this.contentEl)
			.setName('Authenticator code')
			.setDesc('Use the current one-time code from your authenticator app.')
			.addText((text) =>
				text
					.setPlaceholder('123456')
					.setValue(this.otpCode)
					.onChange((value) => {
						this.otpCode = value.trim();
					}),
			);
	}

	private renderActions(): void {
		const actionsEl = this.contentEl.createDiv({ cls: 'ugreen-sync-modal-actions' });

		new ButtonComponent(actionsEl)
			.setButtonText(this.challenge === undefined ? 'Sign in' : 'Verify code')
			.setCta()
			.onClick(() => {
				void (this.challenge === undefined ? this.signIn() : this.verifyCode());
			});

		new ButtonComponent(actionsEl)
			.setButtonText('Cancel')
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
		this.message = 'Signing in...';
		this.render();

		try {
			debugLog(this.settings, 'login password submit', {
				mode: this.draft.url.trim() !== '' ? 'url' : 'ugreenlink',
				hasUsername: this.draft.username.trim() !== '',
				hasPassword: this.draft.password !== '',
			});
			const client = createUgreenClient(this.draft);
			const result = await client.login(this.draft.username, this.draft.password);
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
			this.message = 'Authenticator code is required.';
			this.render();
			return;
		}

		this.busy = true;
		this.message = 'Verifying code...';
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
				this.message = 'Enter the next authenticator code and try again.';
				return;
			}
			debugLog(this.settings, 'login otp failed', {
				code: result.code,
				message: result.message,
			});
			this.message = result.message ?? 'Authenticator code could not be verified. Enter a new code and try again.';
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
		new Notice('UGREEN NAS sign-in succeeded.');
		this.close();
	}

	private validateDraft(): string | undefined {
		if (this.draft.url.trim() === '' && this.draft.ugreenLinkId.trim() === '') {
			return 'NAS address or UGREENlink ID is required.';
		}
		if (this.draft.username.trim() === '') {
			return 'Username is required.';
		}
		if (this.draft.password === '') {
			return 'Password is required.';
		}
		return undefined;
	}
}
