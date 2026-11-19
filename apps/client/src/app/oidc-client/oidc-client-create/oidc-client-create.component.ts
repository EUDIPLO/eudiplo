import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  type OnInit,
  type QueryList,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import { FormArray, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import type {
  CreateOidcClientDto,
  OidcClientResponseDto,
  PresentationConfig,
} from '@eudiplo/sdk-core';
import { firstFieldWithError, showFieldsToFix } from '../../common/field-to-fix.util';
import { focusAfterRenderIfLost, focusRowAfterRemoval } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import { getApiErrorMessage } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { fieldErrorMessage, showIssuesAtFields } from '../../utils/form-errors';
import {
  OidcClientSecretDialogComponent,
  type OidcClientSecretDialogData,
} from '../oidc-client-secret-dialog/oidc-client-secret-dialog.component';
import { OidcClientService } from '../oidc-client.service';
import {
  anyCredentialQueryIds,
  commonCredentialQueryIds,
  hasTrustedAuthorities,
  MAX_REDIRECT_URIS,
  MAX_SCOPES,
  notBlankValidator,
  PROFILE_LABELS,
  redirectUriValidator,
  scopeNameValidator,
  uniqueValuesValidator,
} from './oidc-client-form';

type ScopeGroup = FormGroup<{
  scope: FormControl<string>;
  presentationConfigId: FormControl<string>;
}>;

@Component({
  selector: 'app-oidc-client-create',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTooltipModule,
    RouterModule,
    LoadErrorComponent,
  ],
  templateUrl: './oidc-client-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './oidc-client-create.component.scss',
})
export class OidcClientCreateComponent implements OnInit {
  readonly maxRedirectUris = MAX_REDIRECT_URIS;
  readonly maxScopes = MAX_SCOPES;
  readonly profileLabels = PROFILE_LABELS;

  readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, notBlankValidator, Validators.maxLength(200)],
    }),
    profile: new FormControl<'secure' | 'basic'>('secure', { nonNullable: true }),
    redirectUris: new FormArray<FormControl<string>>(
      [],
      [Validators.required, uniqueValuesValidator(null, 'This redirect URI is listed twice')]
    ),
    scopes: new FormArray<ScopeGroup>(
      [],
      [
        uniqueValuesValidator('scope', 'Each scope name can be used once'),
        uniqueValuesValidator('presentationConfigId', 'Each configuration can back one scope'),
      ]
    ),
    useSubject: new FormControl(false, { nonNullable: true }),
    subject: new FormGroup({
      credentialId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
      claim: new FormControl('', {
        nonNullable: true,
        validators: [Validators.required, notBlankValidator, Validators.maxLength(200)],
      }),
    }),
    claimsFrom: new FormControl('', { nonNullable: true }),
  });

  create = true;
  /** Name of the client being edited, once it has loaded. */
  loadedName = '';
  /** While a save runs, so a second click does not send it again. */
  saving = false;
  /** While the client to edit loads; saving before would overwrite it with a blank form. */
  loading = false;
  /** Set when the client to edit could not be loaded; the form stays hidden. */
  loadError = '';
  /** Presentation configs a scope can use; empty until loaded. */
  configs: PresentationConfig[] = [];
  /** While the presentation configs load. */
  configsLoading = false;
  /** Set when the configs could not be loaded; the scopes cannot be chosen then. */
  configsError = '';

  @ViewChild('pageHeading', { read: ElementRef })
  private readonly pageHeading?: ElementRef<HTMLElement>;
  @ViewChild('scopesTitle', { read: ElementRef })
  private readonly scopesTitle?: ElementRef<HTMLElement>;
  @ViewChild('formElement', { read: ElementRef })
  private readonly formElement?: ElementRef<HTMLFormElement>;
  @ViewChildren('redirectUriInput') private readonly redirectUriInputs?: QueryList<
    ElementRef<HTMLInputElement>
  >;
  @ViewChildren('scopeInput') private readonly scopeInputs?: QueryList<
    ElementRef<HTMLInputElement>
  >;
  @ViewChild('addRedirectUriButton', { read: ElementRef })
  private readonly addRedirectUriButton?: ElementRef<HTMLElement>;
  @ViewChild('addScopeButton', { read: ElementRef })
  private readonly addScopeButton?: ElementRef<HTMLElement>;

  private readonly service = inject(OidcClientService);
  private readonly presentations = inject(PresentationManagementService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly injector = inject(Injector);

  constructor() {
    this.form.controls.subject.disable();
    this.form.controls.useSubject.valueChanges.subscribe((use) =>
      use ? this.form.controls.subject.enable() : this.form.controls.subject.disable()
    );
  }

  ngOnInit(): void {
    this.loadConfigs();
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.create = false;
      this.load(id);
    } else {
      this.redirectUris.push(this.redirectUriControl());
      this.scopes.push(this.scopeGroup());
    }
  }

  get redirectUris(): FormArray<FormControl<string>> {
    return this.form.controls.redirectUris;
  }

  get scopes(): FormArray<ScopeGroup> {
    return this.form.controls.scopes;
  }

  /** The configs the scopes use, in scope order. */
  private get selectedConfigs(): (PresentationConfig | undefined)[] {
    return this.scopes.controls
      .map((group) => group.controls.presentationConfigId.value)
      .filter((id) => !!id)
      .map((id) => this.configs.find((config) => config.id === id));
  }

  /** Credential queries for the subject: those every scope's config has. */
  get subjectCredentialIds(): string[] {
    return commonCredentialQueryIds(this.selectedConfigs);
  }

  /** Why a query cannot identify the user, or '' when it can. */
  subjectQueryProblem(credentialId: string): string {
    return hasTrustedAuthorities(this.selectedConfigs, credentialId) ? '' : 'no trusted authority';
  }

  /** Credential queries for the top-level claims: those of any scope's config. */
  get claimsFromIds(): string[] {
    return anyCredentialQueryIds(this.selectedConfigs);
  }

  /** The chosen subject query when no longer every scope's config has it; it stays selectable. */
  get staleSubjectCredentialId(): string {
    const current = this.form.controls.subject.controls.credentialId.value;
    return this.configs.length && current && !this.subjectCredentialIds.includes(current)
      ? current
      : '';
  }

  /** Whether the configs are not there yet, so stored values cannot be checked against them. */
  get configsPending(): boolean {
    return this.configsLoading || !!this.configsError;
  }

  /** The stored subject query while the configs are not there, so it stays visible. */
  get pendingSubjectCredentialId(): string {
    const current = this.form.controls.subject.controls.credentialId.value;
    return this.configsPending && current ? current : '';
  }

  /** The stored top-level claims query while the configs are not there. */
  get pendingClaimsFrom(): string {
    const current = this.form.controls.claimsFrom.value;
    return this.configsPending && current ? current : '';
  }

  /** The chosen top-level claims query when no scope's config has it any more. */
  get staleClaimsFrom(): string {
    const current = this.form.controls.claimsFrom.value;
    return this.configs.length && current && !this.claimsFromIds.includes(current) ? current : '';
  }

  retryLoad(): void {
    this.load(this.route.snapshot.paramMap.get('id')!, true);
  }

  /** Loads the configs for the scopes; after a retry, focus moves to the Scopes title. */
  loadConfigs(retry = false): void {
    this.configsError = '';
    this.configsLoading = true;
    this.presentations
      .loadConfigurations()
      .then(
        (configs) => {
          this.configs = configs;
          if (retry) {
            focusAfterRenderIfLost(this.injector, () => this.scopesTitle?.nativeElement);
          }
        },
        (error) => {
          console.error('Load error:', error);
          this.configsError = getApiErrorMessage(error, 'Failed to load the presentation configs');
        }
      )
      .finally(() => (this.configsLoading = false));
  }

  private load(id: string, retry = false): void {
    this.loading = true;
    this.loadError = '';
    this.service
      .getById(id)
      .then(
        (client) => {
          this.fill(client);
          // The Retry button is gone with the error card.
          if (retry) focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
        },
        (error) => {
          console.error('Load error:', error);
          this.loadError = getApiErrorMessage(error, 'Failed to load OIDC client');
        }
      )
      .finally(() => (this.loading = false));
  }

  /** Name of the page the back link and Cancel lead to: the client being edited, or the list. */
  get backLabel(): string {
    if (this.create) return 'OIDC Clients';
    return this.loadedName || 'OIDC client';
  }

  private fill(client: OidcClientResponseDto): void {
    this.loadedName = client.name;
    this.redirectUris.clear();
    for (const uri of client.redirectUris) this.redirectUris.push(this.redirectUriControl(uri));
    this.scopes.clear();
    for (const scope of client.scopes) this.scopes.push(this.scopeGroup(scope));
    this.form.patchValue({
      name: client.name,
      profile: client.profile,
      useSubject: !!client.subject,
      subject: client.subject ?? { credentialId: '', claim: '' },
      claimsFrom: client.claimsFrom ?? '',
    });
  }

  addRedirectUri(): void {
    if (this.redirectUris.length >= MAX_REDIRECT_URIS) return;
    this.redirectUris.push(this.redirectUriControl());
    focusAfterRenderIfLost(
      this.injector,
      () => this.redirectUriInputs?.last?.nativeElement,
      () => this.addRedirectUriButton?.nativeElement
    );
  }

  removeRedirectUri(index: number): void {
    this.redirectUris.removeAt(index);
    focusRowAfterRemoval(
      this.injector,
      () => this.redirectUriInputs?.map((input) => input.nativeElement),
      index,
      () => this.addRedirectUriButton?.nativeElement
    );
  }

  addScope(): void {
    if (this.scopes.length >= MAX_SCOPES) return;
    this.scopes.push(this.scopeGroup());
    focusAfterRenderIfLost(
      this.injector,
      () => this.scopeInputs?.last?.nativeElement,
      () => this.addScopeButton?.nativeElement
    );
  }

  removeScope(index: number): void {
    this.scopes.removeAt(index);
    focusRowAfterRemoval(
      this.injector,
      () => this.scopeInputs?.map((input) => input.nativeElement),
      index,
      () => this.addScopeButton?.nativeElement
    );
  }

  /** Whether a config with this ID exists. */
  hasConfig(id: string): boolean {
    return this.configs.some((config) => config.id === id);
  }

  /** Why a config cannot back a scope, or '' when it can. */
  configProblem(config: PresentationConfig): string {
    return config.transaction_data?.length ? 'defines transaction data' : '';
  }

  /** Save stays focusable while a save runs, so its tooltip says why it waits. */
  get saveTooltip(): string {
    return this.saving ? 'Saving the OIDC client…' : '';
  }

  /** Message under a field: the backend's issue, else the local validator's message. */
  fieldError(control: string | (string | number)[], localMessage = ''): string {
    const target = this.form.get(control);
    // A validator of this form that explains itself (redirect URI, scope name, duplicate) wins
    // over the generic message for an empty field.
    const own = Object.entries(target?.errors ?? {}).find(
      ([key, error]) => key !== 'server' && typeof error === 'string'
    )?.[1] as string | undefined;
    return fieldErrorMessage(target, own ?? localMessage);
  }

  onSubmit(): void {
    // `disabledInteractive` keeps Save clickable while it looks disabled.
    if (this.saving || this.loading || this.loadError) return;
    if (this.form.invalid) {
      const { name, profile, redirectUris, scopes, useSubject, subject, claimsFrom } =
        this.form.controls;
      showFieldsToFix(this.form, {
        snackBar: this.snackBar,
        injector: this.injector,
        container: () => this.formElement?.nativeElement,
        // The redirect URIs bind `[formControlName]="i"`, which `firstInvalidField` misses.
        field: () => firstFieldWithError(this.formElement?.nativeElement),
        sections: [
          { name: 'Client', controls: [name, profile] },
          { name: 'Redirect URIs', controls: [redirectUris] },
          { name: 'Scopes', controls: [scopes] },
          { name: 'ID Token', controls: [useSubject, subject, claimsFrom] },
        ],
      });
      return;
    }
    this.saving = true;
    const body = this.buildPayload();
    if (this.create) {
      this.service
        .create(body)
        .then(
          ({ clientSecret, id, issuer }) => {
            this.snackBar.open('OIDC client created', 'Close', { duration: 3000 });
            const data: OidcClientSecretDialogData = { clientId: id, clientSecret, issuer };
            const showSecret = () =>
              this.dialog.open(OidcClientSecretDialogComponent, { data, disableClose: true });
            // Opened once the show page is there, so the navigation does not close it. The secret
            // exists only in this response, so it is shown even when the navigation fails.
            return this.router.navigate(['../', id], { relativeTo: this.route }).then(
              () => showSecret(),
              (error) => {
                console.error('Navigation error:', error);
                showSecret();
              }
            );
          },
          (error) => this.saveFailed(error, 'create')
        )
        .finally(() => (this.saving = false));
    } else {
      const id = this.route.snapshot.paramMap.get('id')!;
      this.service
        .update(id, body)
        .then(
          () => {
            this.snackBar.open('OIDC client updated', 'Close', { duration: 3000 });
            return this.router.navigate(['../../', id], { relativeTo: this.route });
          },
          (error) => this.saveFailed(error, 'update')
        )
        .finally(() => (this.saving = false));
    }
  }

  private saveFailed(error: unknown, verb: 'create' | 'update'): void {
    openErrorSnackBar(
      this.snackBar,
      showIssuesAtFields(this.form, error, `Failed to ${verb} OIDC client`)
    );
    console.error(`OIDC client ${verb} error:`, error);
  }

  private buildPayload(): CreateOidcClientDto {
    const value = this.form.getRawValue();
    return {
      name: value.name.trim(),
      profile: value.profile,
      redirectUris: value.redirectUris.map((uri) => uri.trim()),
      scopes: value.scopes.map(({ scope, presentationConfigId }) => ({
        scope: scope.trim(),
        presentationConfigId,
      })),
      subject: value.useSubject
        ? { credentialId: value.subject.credentialId, claim: value.subject.claim.trim() }
        : null,
      claimsFrom: value.claimsFrom || null,
    };
  }

  private redirectUriControl(value = ''): FormControl<string> {
    return new FormControl(value, {
      nonNullable: true,
      validators: [Validators.required, notBlankValidator, redirectUriValidator],
    });
  }

  private scopeGroup(value = { scope: '', presentationConfigId: '' }): ScopeGroup {
    return new FormGroup({
      scope: new FormControl(value.scope, {
        nonNullable: true,
        validators: [Validators.required, notBlankValidator, scopeNameValidator],
      }),
      presentationConfigId: new FormControl(value.presentationConfigId, {
        nonNullable: true,
        validators: [Validators.required],
      }),
    });
  }
}
