import {
  afterNextRender,
  Component,
  type ElementRef,
  Injector,
  type OnDestroy,
  type OnInit,
  ChangeDetectionStrategy,
  signal,
  viewChild,
} from '@angular/core';
import {
  type AbstractControl,
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';

// Angular Material imports
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router } from '@angular/router';
import { OAuth2HttpError } from '@badgateway/oauth2-client';
import { map, merge, Subscription, take } from 'rxjs';

import { FlexLayoutModule } from 'ngx-flexible-layout';
import { EnvironmentService } from '../services/environment.service';
import { ApiService, withoutTrailingSlashes } from '../core';
import { OidcService } from '../core/oidc.service';
import { focusFieldToFix, showFieldsToFix } from '../common/field-to-fix.util';
import { openErrorSnackBar } from '../utils/error-snackbar';

/** The client and instance of a session the login page resumes or reports as ended. */
interface PreviousSession {
  clientId?: string;
  baseUrl?: string;
}

/**
 * What an instance a link chose receives when the user signs in there: the access token of a
 * single sign-on, the client secret the user entered, or the session of the link's own client.
 */
type LinkedInstanceReceives = 'token' | 'secret' | 'link-client';

/** A check of whether the instance at `url` offers SSO. */
interface InstanceCheck {
  readonly url: string;
  done?: Promise<void>;
}

/** The return path if it stays inside the client and does not lead back to the login page. */
function appPath(returnUrl: unknown): string | undefined {
  return typeof returnUrl === 'string' &&
    returnUrl.startsWith('/') &&
    !returnUrl.startsWith('//') &&
    !returnUrl.startsWith('/login')
    ? returnUrl
    : undefined;
}

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatCheckboxModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatSnackBarModule,
    MatTabsModule,
    MatTooltipModule,
    FlexLayoutModule,
  ],
  templateUrl: './login.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./login.component.scss'],
})
export class LoginComponent implements OnInit, OnDestroy {
  loginForm!: FormGroup;
  isLoading = false;
  hideClientSecret = true;
  isDevelopmentMode = false;
  detectedMode: null | 'loading' | 'local' | 'oidc' = null;
  selectedLoginMode: 'sso' | 'client' = 'sso';
  private discoveredIssuer?: string;
  private discoveredUiClientId?: string;
  /** The kept session this page waits for instead of showing the form. */
  readonly keptSession = signal<PreviousSession | null>(null);
  /**
   * The session this page resumes or that just ended: the form starts from it,
   * and only a sign-in as the same client returns to its page.
   */
  private previousSession?: PreviousSession;
  /** The in-app page the guard sent the user away from. */
  private returnUrl?: string;
  readonly retryingKeptSession = signal(false);
  private keptSessionEvents?: Subscription;
  private readonly formElement = viewChild<ElementRef<HTMLFormElement>>('formElement');
  private readonly apiUrlInput = viewChild<ElementRef<HTMLInputElement>>('apiUrlInput');
  private readonly clientSecretInput = viewChild<ElementRef<HTMLInputElement>>('clientSecretInput');
  /** An ended session signed in with client credentials, so the form stays on that tab even where SSO is offered. */
  private keepClientCredentialsTab = false;
  /** The last check of whether an instance offers SSO; an earlier one that answers late is ignored. */
  private instanceCheck?: InstanceCheck;
  /** A submit on the SSO tab waits for the instance check. */
  private waitingForInstanceCheck = false;
  /**
   * The instance the link chose that the user agreed to sign in at, and what it receives then,
   * so a retry does not ask again.
   */
  private confirmedInstance?: { url: string; receives: LinkedInstanceReceives };

  constructor(
    private readonly formBuilder: FormBuilder,
    private readonly apiService: ApiService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly environmentService: EnvironmentService,
    private readonly oidcService: OidcService,
    private readonly injector: Injector
  ) {}

  ngOnInit(): void {
    this.isDevelopmentMode = this.environmentService.isDevelopment();

    // Check if user is already authenticated
    this.returnUrl = appPath(this.route.snapshot.queryParams['returnUrl']);
    if (this.apiService.getAuthenticationStatus()) {
      this.continueToApp();
      return;
    }
    if (this.apiService.hasKeptSession()) {
      this.waitForKeptSession();
    } else {
      // The session may have expired or been rejected before this page opened.
      this.reportEndedSession();
    }
    this.initializeForm();

    const initialApiUrl = this.loginForm.get('apiUrl')?.value;
    if (initialApiUrl) {
      void this.detectMode(initialApiUrl);
    }

    // Auto-login if all required params are provided via URL
    this.autoLoginIfParamsProvided();
  }

  ngOnDestroy(): void {
    this.keptSessionEvents?.unsubscribe();
  }

  /** Waits until the kept session renews its token or ends, instead of asking for credentials it has. */
  private waitForKeptSession(): void {
    this.previousSession = {
      clientId: this.apiService.getClientId(),
      baseUrl: this.apiService.getBaseUrl(),
    };
    this.keptSession.set(this.previousSession);
    this.keptSessionEvents = merge(
      this.apiService.tokenRenewed$.pipe(map(() => true)),
      this.apiService.sessionEnded$.pipe(map(() => false))
    )
      .pipe(take(1))
      .subscribe((resumed) => {
        if (resumed) {
          this.keptSession.set(null);
          this.continueToApp();
          return;
        }
        this.showForm();
        this.reportEndedSession();
      });
    // Nothing may be due soon, for example after the laptop slept past the token's expiry.
    // This joins a renewal already in flight; failures are retried or end the session.
    void this.apiService.refreshAccessToken().catch(() => undefined);
  }

  /** Says why the previous session ended; the form starts from its client and instance. */
  private reportEndedSession(): void {
    const ended = this.apiService.takeEndedSession();
    if (!ended) return;
    this.previousSession = { clientId: ended.clientId, baseUrl: ended.baseUrl };
    this.keepClientCredentialsTab = true;
    this.selectedLoginMode = 'client';
    if (ended.reason === 'expired') {
      // Only the secret is left to enter. Rejected credentials may need another client.
      afterNextRender(() => this.clientSecretInput()?.nativeElement.focus(), {
        injector: this.injector,
      });
    }
    const [message, panelClass] =
      ended.reason === 'expired'
        ? [
            `The session of ${ended.clientId} expired. Log in again to continue.`,
            'warning-snackbar',
          ]
        : [
            `The credentials of ${ended.clientId} were rejected, for example because the client was deleted or its secret changed. Log in again.`,
            'error-snackbar',
          ];
    this.snackBar.open(message, 'Close', { duration: 10_000, panelClass: [panelClass] });
  }

  /** Renews the kept session now instead of waiting for the next automatic attempt. */
  async retryKeptSession(): Promise<void> {
    this.retryingKeptSession.set(true);
    try {
      await this.apiService.refreshAccessToken();
    } catch (error) {
      // A rejection ends the session, and waitForKeptSession reports it.
      if (this.keptSession()) {
        const reason =
          error instanceof OAuth2HttpError
            ? `The token request failed with status ${error.httpCode}`
            : 'The backend still cannot be reached';
        this.snackBar.open(`${reason}. This page keeps trying.`, 'Close', {
          duration: 5000,
          panelClass: ['error-snackbar'],
        });
      }
    } finally {
      this.retryingKeptSession.set(false);
    }
  }

  /** Forgets the kept session, so the user can sign in with other credentials. */
  discardKeptSession(): void {
    this.stopWaitingForKeptSession();
    this.apiService.logout();
    // Another client or instance may lack the page the old session was on.
    this.returnUrl = undefined;
    this.showForm();
  }

  /** Shows the form in place of the kept session and moves focus to its first field. */
  private showForm(): void {
    this.keptSession.set(null);
    afterNextRender(() => this.apiUrlInput()?.nativeElement.focus(), { injector: this.injector });
  }

  private stopWaitingForKeptSession(): void {
    this.keptSessionEvents?.unsubscribe();
    this.keptSessionEvents = undefined;
    this.keptSession.set(null);
  }

  /** Opens the page the guard sent the user away from, or the dashboard. */
  private continueToApp(): void {
    void this.router.navigateByUrl(this.returnUrl ?? '/dashboard');
  }

  private autoLoginIfParamsProvided(): void {
    const queryParams = this.route.snapshot.queryParams;

    // Check if all required params are in the URL
    if (queryParams['clientId'] && queryParams['clientSecret'] && queryParams['apiUrl']) {
      this.selectedLoginMode = 'client';
      this.syncLoginModeState();
      void this.onSubmit();
    }
  }

  private initializeForm(): void {
    const env = this.environmentService.getEnvironment();
    const queryParams = this.route.snapshot.queryParams;

    const kept = this.previousSession;

    // Priority order: URL params > the previous session > environment values (in dev) > empty strings
    const getParamValue = (paramName: string, envValue: string, keptValue?: string): string => {
      // First check URL query parameters
      if (queryParams[paramName]) {
        return queryParams[paramName];
      }

      // Then the session this page resumes or that just ended
      if (keptValue) {
        return keptValue;
      }

      // Then check environment values if in development mode
      if (this.environmentService.isDevelopment() && envValue) {
        return envValue;
      }

      //check if defined in window
      if ((globalThis as any).env?.[paramName]) {
        return (globalThis as any).env[paramName];
      }

      // Default to empty string
      return '';
    };

    const defaultValues = {
      clientId: getParamValue('clientId', env.oidc.clientId, kept?.clientId),
      clientSecret: getParamValue('clientSecret', env.oidc.clientSecret),
      apiUrl: getParamValue('apiUrl', env.api.baseUrl, kept?.baseUrl),
    };

    this.loginForm = this.formBuilder.group({
      clientId: [defaultValues.clientId, [Validators.required, Validators.required]],
      clientSecret: [defaultValues.clientSecret, [Validators.required, Validators.required]],
      apiUrl: [defaultValues.apiUrl, [Validators.required, Validators.pattern(/^https?:\/\/.+/)]],
    });
  }

  onApiUrlBlur(): void {
    const url = this.loginForm.get('apiUrl')?.value;
    if (url) {
      void this.detectMode(url);
    }
  }

  onLoginTabChange(index: number): void {
    this.selectedLoginMode = index === 0 ? 'sso' : 'client';
    // The user chose SSO after an ended session; detecting the mode again keeps that choice.
    if (index === 0) this.keepClientCredentialsTab = false;
    this.syncLoginModeState();
  }

  private setClientCredentialValidators(required: boolean): void {
    const clientIdControl = this.loginForm.get('clientId');
    const clientSecretControl = this.loginForm.get('clientSecret');

    if (required) {
      clientIdControl?.setValidators([Validators.required]);
      clientSecretControl?.setValidators([Validators.required]);
    } else {
      clientIdControl?.clearValidators();
      clientSecretControl?.clearValidators();
    }

    clientIdControl?.updateValueAndValidity({ emitEvent: false });
    clientSecretControl?.updateValueAndValidity({ emitEvent: false });
  }

  private syncLoginModeState(): void {
    const requiresClientCredentials =
      this.selectedLoginMode === 'client' ||
      this.detectedMode === 'local' ||
      this.detectedMode === null;

    this.setClientCredentialValidators(requiresClientCredentials);
  }

  /** Checks whether the instance at `apiUrl` offers SSO and opens the tab to sign in with. */
  private detectMode(apiUrl: string): Promise<void> {
    const check: InstanceCheck = { url: withoutTrailingSlashes(apiUrl) };
    this.instanceCheck = check;
    check.done = this.checkInstance(check);
    return check.done;
  }

  /**
   * Waits until the instance URL the field holds is checked: by the check running or done for
   * it, else a new one, and again when the URL changes meanwhile.
   */
  private async instanceInFieldChecked(): Promise<void> {
    const url = withoutTrailingSlashes(this.apiUrlControl.value);
    if (this.instanceCheck?.url !== url) void this.detectMode(url);
    const check = this.instanceCheck;
    await check?.done;
    // A newer check started meanwhile, for an edited URL or after leaving the field again.
    if (check !== this.instanceCheck) await this.instanceInFieldChecked();
  }

  private async checkInstance(check: InstanceCheck): Promise<void> {
    const normalizedUrl = check.url;
    this.detectedMode = 'loading';

    try {
      const discovery = await this.apiService.fetchDiscovery(normalizedUrl);
      // A check started since then decides.
      if (this.instanceCheck !== check) return;

      if (discovery?.ui_client_id) {
        this.detectedMode = 'oidc';
        // Another instance than the ended session's opens like a fresh login page.
        const sameInstance = normalizedUrl === this.previousSession?.baseUrl;
        this.selectedLoginMode = this.keepClientCredentialsTab && sameInstance ? 'client' : 'sso';
        this.discoveredIssuer = discovery.issuer;
        this.discoveredUiClientId = discovery.ui_client_id;
      } else {
        this.detectedMode = 'local';
        this.selectedLoginMode = 'client';
        this.discoveredIssuer = undefined;
        this.discoveredUiClientId = undefined;
      }
    } catch {
      if (this.instanceCheck !== check) return;
      this.detectedMode = 'local';
      this.selectedLoginMode = 'client';
      this.discoveredIssuer = undefined;
      this.discoveredUiClientId = undefined;
    }

    this.syncLoginModeState();
  }

  get isSsoAvailable(): boolean {
    return this.detectedMode === 'oidc';
  }

  get isSsoTabDisabled(): boolean {
    return this.detectedMode === 'local';
  }

  get submitLabel(): string {
    return this.selectedLoginMode === 'sso' ? 'Login with SSO' : 'Login with Client Credentials';
  }

  get loadingLabel(): string {
    return this.selectedLoginMode === 'sso' ? 'Redirecting to SSO...' : 'Authenticating...';
  }

  /**
   * Why the login button cannot be used now, for its tooltip; empty while it can. Missing or
   * invalid fields are no such reason: submitting says which ones to fix.
   */
  get loginUnavailableReason(): string {
    if (this.isLoading) {
      return this.selectedLoginMode === 'sso'
        ? 'Redirecting to the identity provider…'
        : 'Signing in…';
    }
    // Without a valid instance URL, the URL is what to fix. A submit waits for the check.
    return this.selectedLoginMode === 'sso' &&
      this.apiUrlControl.valid &&
      this.detectedMode === 'loading'
      ? 'Checking whether this instance offers SSO…'
      : '';
  }

  private get apiUrlControl(): AbstractControl {
    return this.loginForm.get('apiUrl')!;
  }

  async onSubmit(): Promise<void> {
    // `disabledInteractive` keeps the button clickable while it looks disabled.
    if (this.isLoading || this.waitingForInstanceCheck) return;
    if (this.selectedLoginMode === 'sso') {
      // SSO needs only the instance URL; the client credentials are on the other tab.
      if (this.apiUrlControl.invalid) {
        this.showFieldsToFix(this.apiUrlControl);
        return;
      }
      // A click right after leaving the instance field comes while its check runs, and Enter in
      // the field comes before the URL it holds was checked.
      this.waitingForInstanceCheck = true;
      try {
        await this.instanceInFieldChecked();
      } finally {
        this.waitingForInstanceCheck = false;
      }
      if (this.apiUrlControl.invalid) {
        this.showFieldsToFix(this.apiUrlControl);
        return;
      }
      if (this.selectedLoginMode !== 'sso') {
        this.askForClientCredentials();
        return;
      }
    } else if (this.loginForm.invalid) {
      this.showFieldsToFix(this.loginForm);
      return;
    }

    const formValue = this.loginForm.value;
    const normalizedUrl = withoutTrailingSlashes(formValue.apiUrl);
    if (!this.confirmInstanceFromLink(normalizedUrl)) return;

    // Signing in with the form replaces a kept session.
    this.stopWaitingForKeptSession();
    this.isLoading = true;

    try {
      if (this.selectedLoginMode === 'sso') {
        const issuerUrl = this.discoveredIssuer;
        const uiClientId = this.discoveredUiClientId;

        if (!issuerUrl || !uiClientId) {
          throw new Error('OIDC mode detected but discovery metadata is incomplete.');
        }

        await this.oidcService.redirectToLogin({
          issuerUrl,
          uiClientId,
          apiUrl: normalizedUrl,
        });
        return;
      }

      // A sign-in with the link's own client does not make its instance one the user knows.
      const linkCredentials = this.linkCredentialsInForm();
      await this.apiService.loginWithClientCredentials(
        formValue.clientId,
        formValue.clientSecret,
        normalizedUrl,
        this.discoveredIssuer
      );

      // Attempt to refresh/get access token
      await this.apiService.refreshAccessToken();
      if (!linkCredentials) this.apiService.rememberSignedInInstance(normalizedUrl);

      this.snackBar.open('Login successful!', 'Close', {
        duration: 3000,
        panelClass: ['success-snackbar'],
      });

      // Only the previous session's client returns to its page; another one may lack it.
      const previous = this.previousSession;
      if (
        previous &&
        (formValue.clientId !== previous.clientId || normalizedUrl !== previous.baseUrl)
      ) {
        this.returnUrl = undefined;
      }
      this.continueToApp();
    } catch (error: any) {
      console.error('Login failed:', error);

      // Provide specific error messages based on the error type
      let errorMessage = 'Login failed. ';
      if (error?.message?.includes('fetch') || error?.name === 'TypeError') {
        errorMessage +=
          'Could not connect to EUDIPLO. Check if the instance URL is correct and the server is running.';
      } else if (error?.status === 401 || error?.message?.includes('401')) {
        errorMessage += 'Invalid credentials. Please check your Client ID and Client Secret.';
      } else if (error?.status === 404 || error?.message?.includes('404')) {
        errorMessage += 'Endpoint not found. Please verify the EUDIPLO instance URL.';
      } else {
        errorMessage += 'Please check your credentials and instance URL.';
      }

      this.snackBar.open(errorMessage, 'Close', {
        duration: 8000,
        panelClass: ['error-snackbar'],
      });
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Whether to sign in at `url`. The instance receives the access token or the client secret,
   * and nothing ties it to the identity provider it names. So the user confirms an instance that
   * the link opening this page chose, unless the console knows it already. This also applies to
   * a link with its own credentials. An agreement covers only what the instance receives with it:
   * agreeing to the link's client does not cover sending it the access token of an SSO.
   */
  private confirmInstanceFromLink(url: string): boolean {
    const link = this.route.snapshot.queryParams;
    const linked: unknown = link['apiUrl'];
    if (typeof linked !== 'string' || withoutTrailingSlashes(linked) !== url) return true;
    const receives = this.linkedInstanceReceives();
    const confirmed = this.confirmedInstance;
    if (confirmed?.url === url && confirmed.receives === receives) return true;
    if (this.knownInstances().includes(url)) return true;
    if (globalThis.confirm(this.linkedInstanceQuestion(url, receives))) {
      this.confirmedInstance = { url, receives };
      return true;
    }
    if (this.keptSession()) {
      // The page keeps waiting for the kept session instead of showing the form.
      this.snackBar.open(`Not signed in at ${url}. The previous session continues.`, 'Close', {
        duration: 10_000,
        panelClass: ['warning-snackbar'],
      });
      return false;
    }
    // The link's client belongs to the instance the user declined.
    if (this.linkCredentialsInForm()) this.loginForm.patchValue({ clientId: '', clientSecret: '' });
    this.snackBar.open(
      `Not signed in at ${url}. Enter the address of an EUDIPLO instance you trust.`,
      'Close',
      { duration: 10_000, panelClass: ['warning-snackbar'] }
    );
    afterNextRender(() => this.apiUrlInput()?.nativeElement.focus(), { injector: this.injector });
    return false;
  }

  /** The form still holds the client ID and secret of the link that opened this page. */
  private linkCredentialsInForm(): boolean {
    const link = this.route.snapshot.queryParams;
    const { clientId, clientSecret } = this.loginForm.value;
    return (
      !!link['clientSecret'] &&
      clientId === link['clientId'] &&
      clientSecret === link['clientSecret']
    );
  }

  /** What the instance receives when the user signs in with the form as it is. */
  private linkedInstanceReceives(): LinkedInstanceReceives {
    if (this.selectedLoginMode === 'sso') return 'token';
    return this.linkCredentialsInForm() ? 'link-client' : 'secret';
  }

  /** The question before signing in at `url`, which the link chose. */
  private linkedInstanceQuestion(url: string, receives: LinkedInstanceReceives): string {
    const consequence = {
      token:
        'After you sign in, the console sends it your access token, which lets it act with your roles.',
      'link-client':
        'It signs you in with the client the link names, and everything you do in the console goes to this instance.',
      secret:
        'Signing in sends it the client secret you entered, which lets it act as this client.',
    }[receives];
    return `The link you opened chose the EUDIPLO instance ${url}. ${consequence} Sign in only if you trust this instance.`;
  }

  /** The instance this deployment of the console names, and the one this browser last signed in to. */
  private knownInstances(): string[] {
    const runtime = (globalThis as { env?: { apiUrl?: string } }).env?.apiUrl;
    // The production build only has a placeholder.
    const development = this.environmentService.isDevelopment()
      ? this.environmentService.getEnvironment().api.baseUrl
      : undefined;
    return [runtime, development, this.apiService.lastSignedInInstance()]
      .filter((url): url is string => !!url)
      .map(withoutTrailingSlashes);
  }

  private showFieldsToFix(fields: AbstractControl): void {
    showFieldsToFix(fields, {
      snackBar: this.snackBar,
      injector: this.injector,
      container: () => this.formElement()?.nativeElement,
    });
  }

  /**
   * After a submit on the SSO tab opened the Client ID and Secret tab, says so and focuses the
   * client ID, or the first field to fix, instead of signing in a way the user did not choose.
   */
  private askForClientCredentials(): void {
    this.loginForm.markAllAsTouched();
    openErrorSnackBar(
      this.snackBar,
      'SSO is not available for this instance. Sign in with a client ID and secret.'
    );
    const container = () => this.formElement()?.nativeElement;
    focusFieldToFix(this.injector, container, {
      fallback: () => container()?.querySelector<HTMLElement>('[formcontrolname="clientId"]'),
    });
  }

  getErrorMessage(fieldName: string): string {
    const field = this.loginForm.get(fieldName);

    if (field?.hasError('required')) {
      return `${this.getFieldDisplayName(fieldName)} is required`;
    }

    if (field?.hasError('pattern')) {
      return `${this.getFieldDisplayName(fieldName)} must be a valid URL`;
    }

    if (field?.hasError('minlength')) {
      const requiredLength = field.errors?.['minlength']?.requiredLength;
      return `${this.getFieldDisplayName(fieldName)} must be at least ${requiredLength} characters long`;
    }

    return '';
  }

  private getFieldDisplayName(fieldName: string): string {
    const displayNames: Record<string, string> = {
      oidcUrl: 'OIDC Discovery URL',
      clientId: 'Client ID',
      clientSecret: 'Client Secret',
      apiUrl: 'EUDIPLO Instance',
    };
    return displayNames[fieldName] || fieldName;
  }

  toggleClientSecretVisibility(): void {
    this.hideClientSecret = !this.hideClientSecret;
  }
}
