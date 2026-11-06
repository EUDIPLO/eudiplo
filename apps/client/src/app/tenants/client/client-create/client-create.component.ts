import {
  Component,
  OnInit,
  ChangeDetectionStrategy,
  ElementRef,
  Injector,
  QueryList,
  ViewChildren,
  inject,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators, type FormGroup } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import {
  clientControllerCreateClient,
  clientControllerGetClient,
  clientControllerUpdateClient,
  type CreateClientDto,
  type UpdateClientDto,
} from '@eudiplo/sdk-core';
import { ApiService } from '../../../core';
import { JwtService } from '../../../services/jwt.service';
import { type Role, type RoleOption, roleChoices } from '../../../services/role-grants';
import { getApiErrorMessage, type LabelledFailure } from '../../../utils/error-message';
import { MatSelect, MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PresentationManagementService } from '../../../presentation/presentation-config/presentation-management.service';
import { CredentialConfigService } from '../../../issuance/credential-config/credential-config.service';
import { SecretDialogComponent } from '../secret-dialog/secret-dialog.component';
import { ConfigOwnershipDirective } from '../../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../../config-portability/config-ownership-notice.component';
import { RoleLockNoticeComponent } from '../../../common/role-lock-notice.component';
import { openErrorSnackBar } from '../../../utils/error-snackbar';
import {
  type SourceLoadState,
  loadSource,
  reportSourceFailures,
} from '../../../common/load-source';
import { focusAfterRenderIfLost } from '../../../common/focus-if-lost.util';

/** The config lists a client can be restricted to. */
export type ConfigSource = 'presentationConfigs' | 'issuanceConfigs';

/** Where a config select stands: it can be changed only once its source has loaded. */
export type ConfigSourceStatus = SourceLoadState | 'forbidden';

interface ConfigSourceInfo {
  /** Form control holding the client's allowed IDs of this source */
  control: 'allowedPresentationConfigs' | 'allowedIssuanceConfigs';
  title: string;
  label: string;
  /** Roles that may list the source, as the backend checks them; one of them is enough. */
  roles: Role[];
}

export const configSources: Record<ConfigSource, ConfigSourceInfo> = {
  presentationConfigs: {
    control: 'allowedPresentationConfigs',
    title: 'Allowed Presentation Configurations',
    label: 'presentation configurations',
    roles: ['presentation:manage', 'presentation:request'],
  },
  issuanceConfigs: {
    control: 'allowedIssuanceConfigs',
    title: 'Allowed Credential Configurations',
    label: 'credential configurations',
    roles: ['issuance:manage'],
  },
};

@Component({
  selector: 'app-client-create',
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    FlexLayoutModule,
    MatSelectModule,
    RouterModule,
    MatTooltipModule,
    MatDialogModule,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    RoleLockNoticeComponent,
  ],
  templateUrl: './client-create.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './client-create.component.scss',
})
export class ClientCreateComponent implements OnInit {
  clientForm: FormGroup;
  isSubmitting = false;
  hasPermission = false;

  /**
   * Roles available for selection: the roles the signed-in caller may grant,
   * plus the other roles of the edited client, which stay selected and cannot
   * be changed.
   */
  roleOptions: RoleOption[] = [];
  /** Explains which roles the caller can grant */
  grantHint = '';
  /** Roles of the edited client that the caller neither holds nor may grant */
  unmanageableRoles: string[] = [];
  loaded = false;
  id?: string | null;

  readonly configSources = configSources;
  readonly configSourceIds = Object.keys(configSources) as ConfigSource[];

  /** Load state of each config list, so an empty select is not mistaken for "none exist". */
  readonly configLoadState: Record<ConfigSource, SourceLoadState> = {
    presentationConfigs: 'loading',
    issuanceConfigs: 'loading',
  };

  /**
   * Options of each config select: the configs that exist plus the IDs the
   * client has stored, so a stored ID stays visible and selected while its
   * list is not loaded or after its config was deleted.
   */
  configOptions: Record<ConfigSource, string[]> = { presentationConfigs: [], issuanceConfigs: [] };

  private readonly availableConfigs: Record<ConfigSource, string[]> = {
    presentationConfigs: [],
    issuanceConfigs: [],
  };
  private readonly storedConfigs: Record<ConfigSource, string[]> = {
    presentationConfigs: [],
    issuanceConfigs: [],
  };
  /**
   * Whether the caller's roles may read each config list, decided once, so
   * the request, the lock and the hint of a select always agree.
   */
  private readonly listable: Record<ConfigSource, boolean>;

  @ViewChildren(MatSelect, { read: ElementRef })
  private selectElements?: QueryList<ElementRef<HTMLElement>>;
  @ViewChildren('retryButton', { read: ElementRef })
  private retryButtons?: QueryList<ElementRef<HTMLElement>>;

  private readonly injector = inject(Injector);

  constructor(
    private readonly fb: FormBuilder,
    private readonly snackBar: MatSnackBar,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly apiService: ApiService,
    private readonly presentationManagementService: PresentationManagementService,
    private readonly credentialConfigService: CredentialConfigService,
    private readonly dialog: MatDialog,
    private readonly jwtService: JwtService
  ) {
    this.clientForm = this.fb.group({
      clientId: ['', [Validators.required, Validators.minLength(1), this.clientIdValidator]],
      description: [''],
      roles: [[], [Validators.required]],
      allowedPresentationConfigs: [[]],
      allowedIssuanceConfigs: [[]],
    });

    this.roleOptions = roleChoices(this.jwtService.getRoles()).options;
    this.grantHint = this.jwtService.grantHint();
    this.listable = {
      presentationConfigs: this.jwtService.hasRole(configSources.presentationConfigs.roles),
      issuanceConfigs: this.jwtService.hasRole(configSources.issuanceConfigs.roles),
    };
  }
  ngOnInit(): void {
    this.syncConfigLocks();
    void this.loadAvailableConfigs();

    this.id = this.route.snapshot.paramMap.get('id');
    if (this.id) {
      this.loaded = true;
      clientControllerGetClient({ path: { id: this.id } }).then((res) => {
        if (!res.data) {
          this.snackBar.open('Client not found', 'Close', { duration: 3000 });
          this.router.navigate(['../..'], { relativeTo: this.route });
          return;
        }
        const clientData = res.data;
        this.clientForm.patchValue({
          ...clientData,
          allowedPresentationConfigs: clientData.allowedPresentationConfigs ?? [],
          allowedIssuanceConfigs: clientData.allowedIssuanceConfigs ?? [],
        });
        this.clientForm.get('clientId')?.disable();
        const choices = roleChoices(this.jwtService.getRoles(), clientData.roles ?? []);
        this.roleOptions = choices.options;
        this.unmanageableRoles = choices.unmanageable;
        this.storedConfigs.presentationConfigs = clientData.allowedPresentationConfigs ?? [];
        this.storedConfigs.issuanceConfigs = clientData.allowedIssuanceConfigs ?? [];
        this.updateConfigOptions();
        if (this.unmanageableRoles.length > 0) {
          this.clientForm.disable();
        }
        this.syncConfigLocks();
      });
    }
  }

  /** Where the select of `source` stands; it can be changed only when 'loaded'. */
  configStatus(source: ConfigSource): ConfigSourceStatus {
    return this.listable[source] ? this.configLoadState[source] : 'forbidden';
  }

  /** Hint under the select of `source`: how to use it, or why it is locked. */
  configHint(source: ConfigSource): string {
    const { control, label, roles } = configSources[source];
    const selected = (this.clientForm.get(control)?.value as string[] | null) ?? [];
    const kept =
      selected.length > 0
        ? `The client stays limited to ${selected.join(', ')}.`
        : `The client may use all ${label}.`;
    // The role lock notice above the form says why the whole form is locked.
    if (this.unmanageableRoles.length > 0) return kept;
    switch (this.configStatus(source)) {
      case 'forbidden':
        return `Locked: listing ${label} needs ${roles.join(' or ')}. ${kept}`;
      case 'loading':
        return `Loading ${label}…`;
      case 'failed':
        return `Locked: could not load ${label}. ${kept}`;
      case 'loaded':
        return this.configOptions[source].length > 0
          ? `Leave empty to allow all ${label}`
          : `No ${label} exist yet. The client may use all of them, including those created later.`;
    }
  }

  /** Whether `id` is an ID the client has stored that no longer names an existing config. */
  isMissingConfig(source: ConfigSource, id: string): boolean {
    return this.configLoadState[source] === 'loaded' && !this.availableConfigs[source].includes(id);
  }

  /** Loads one config list again, then moves focus to its select or, failing again, to Retry. */
  async retryConfigs(source: ConfigSource): Promise<void> {
    reportSourceFailures(this.snackBar, [await this.configLoaders[source]()]);
    focusAfterRenderIfLost(this.injector, () =>
      this.configStatus(source) === 'loaded'
        ? this.findBySource(this.selectElements, source)
        : this.findBySource(this.retryButtons, source)
    );
  }

  private findBySource(
    elements: QueryList<ElementRef<HTMLElement>> | undefined,
    source: ConfigSource
  ): HTMLElement | undefined {
    return elements?.find((element) => element.nativeElement.dataset['source'] === source)
      ?.nativeElement;
  }

  /** Loaders of the config lists; each records its own state, so one failure leaves the other list usable. */
  private readonly configLoaders: Record<ConfigSource, () => Promise<LabelledFailure | undefined>> =
    {
      presentationConfigs: () =>
        this.loadConfigs('presentationConfigs', async () =>
          (await this.presentationManagementService.loadConfigurations()).map((c) => c.id)
        ),
      issuanceConfigs: () =>
        this.loadConfigs('issuanceConfigs', async () =>
          (await this.credentialConfigService.loadConfigurations()).map((c) => c.id)
        ),
    };

  private async loadConfigs(
    source: ConfigSource,
    load: () => Promise<string[]>
  ): Promise<LabelledFailure | undefined> {
    const failure = await loadSource(
      this.configLoadState,
      source,
      configSources[source].label,
      async () => {
        this.availableConfigs[source] = await load();
      }
    );
    this.updateConfigOptions();
    this.syncConfigLocks();
    return failure;
  }

  /**
   * Loads the config lists the caller's roles may read, each on its own, and
   * names those that failed in one snackbar. A list the caller may not read is
   * not requested; its select stays locked with the stored IDs. A list the
   * user retried meanwhile is left out: its Retry reports its own outcome.
   */
  private async loadAvailableConfigs(): Promise<void> {
    const results = await Promise.all(
      this.configSourceIds
        .filter((source) => this.listable[source])
        .map(async (source) => ({ source, failure: await this.configLoaders[source]() }))
    );
    reportSourceFailures(
      this.snackBar,
      results
        .filter(({ source }) => this.configLoadState[source] === 'failed')
        .map(({ failure }) => failure)
    );
  }

  private updateConfigOptions(): void {
    for (const source of this.configSourceIds) {
      this.configOptions[source] = [
        ...new Set([...this.availableConfigs[source], ...this.storedConfigs[source]]),
      ];
    }
  }

  /**
   * Locks a config select while its list is not loaded, so the IDs the client
   * has stored are sent back as they are instead of being replaced by a
   * choice among options the page does not know. `getRawValue()` still sends
   * a locked select's value.
   */
  private syncConfigLocks(): void {
    for (const source of this.configSourceIds) {
      const control = this.clientForm.get(configSources[source].control);
      const locked = this.unmanageableRoles.length > 0 || this.configStatus(source) !== 'loaded';
      if (locked && control?.enabled) {
        control.disable({ emitEvent: false });
      } else if (!locked && control?.disabled) {
        control.enable({ emitEvent: false });
      }
    }
  }

  private buildCreateClientPayload(): CreateClientDto {
    const rawValue = this.clientForm.getRawValue() as Partial<CreateClientDto> & {
      clientId?: unknown;
      description?: unknown;
      allowedPresentationConfigs?: unknown;
      allowedIssuanceConfigs?: unknown;
      roles?: string[];
    };
    const clientId = typeof rawValue.clientId === 'string' ? rawValue.clientId.trim() : '';
    const description =
      typeof rawValue.description === 'string' ? rawValue.description.trim() : rawValue.description;

    return {
      clientId,
      description: description || undefined,
      roles: rawValue.roles ?? [],
      allowedPresentationConfigs: this.normalizeStringList(rawValue.allowedPresentationConfigs),
      allowedIssuanceConfigs: this.normalizeStringList(rawValue.allowedIssuanceConfigs),
    };
  }

  private buildUpdateClientPayload(): UpdateClientDto {
    const rawValue = this.clientForm.getRawValue() as Partial<UpdateClientDto> & {
      description?: unknown;
      allowedPresentationConfigs?: unknown;
      allowedIssuanceConfigs?: unknown;
      roles?: string[];
    };
    const description =
      typeof rawValue.description === 'string' ? rawValue.description.trim() : rawValue.description;

    return {
      description: description || undefined,
      roles: rawValue.roles ?? [],
      allowedPresentationConfigs: this.normalizeStringList(rawValue.allowedPresentationConfigs),
      allowedIssuanceConfigs: this.normalizeStringList(rawValue.allowedIssuanceConfigs),
    };
  }

  private clientIdValidator(control: {
    value: string | null | undefined;
  }): Record<string, boolean> | null {
    const value = control.value?.trim();
    if (!value) {
      return null;
    }

    const validPattern = /^[A-Za-z0-9._:-]+$/;
    return validPattern.test(value) ? null : { invalidClientId: true };
  }

  private normalizeStringList(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0
      );
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return [value.trim()];
    }

    return [];
  }

  async onSubmit(): Promise<void> {
    this.isSubmitting = true;

    try {
      if (this.loaded) {
        const payload = this.buildUpdateClientPayload();

        await clientControllerUpdateClient({
          path: { id: this.id! },
          body: payload,
        });
        this.snackBar.open('Client updated successfully', 'Close', {
          duration: 3000,
        });
        await this.router.navigate(['..'], { relativeTo: this.route });

        //in case user updated its own client, refresh the token
        if (this.apiService.getClientId() === this.id) {
          // A failed refresh retries or ends the session on its own
          void this.apiService.refreshAccessToken().catch(() => undefined);
        }
      } else {
        const payload = this.buildCreateClientPayload();

        const result = await clientControllerCreateClient({
          body: payload,
        });

        // Cast to expected type since SDK returns generic response
        const clientData = result.data as typeof result.data & { clientSecret?: string };

        // Show secret dialog for new clients
        if (clientData?.clientSecret) {
          const dialogRef = this.dialog.open(SecretDialogComponent, {
            data: {
              clientId: clientData.clientId,
              secret: clientData.clientSecret,
              apiUrl: this.apiService.getBaseUrl(),
            },
            width: '500px',
            disableClose: true,
          });

          // Wait for dialog to close before navigating
          dialogRef.afterClosed().subscribe(() => {
            this.router.navigate(['..'], { relativeTo: this.route });
          });
        } else {
          this.snackBar.open('Client created successfully', 'Close', {
            duration: 3000,
          });
          await this.router.navigate(['..'], { relativeTo: this.route });
        }
      }
    } catch (error) {
      openErrorSnackBar(
        this.snackBar,
        getApiErrorMessage(error, `Failed to ${this.loaded ? 'update' : 'create'} client`)
      );
    } finally {
      this.isSubmitting = false;
    }
  }

  onCancel(): void {
    this.router.navigate(['../'], { relativeTo: this.route });
  }
}
