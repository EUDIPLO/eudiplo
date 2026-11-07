import { Directive, ElementRef, inject, Injector, type OnInit, ViewChild } from '@angular/core';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import type { MatDialog } from '@angular/material/dialog';
import type { MatSnackBar } from '@angular/material/snack-bar';
import type { ActivatedRoute, Router } from '@angular/router';

import { JsonViewDialogComponent } from '../issuance/credential-config/credential-config-create/json-view-dialog/json-view-dialog.component';
import { getApiErrorMessage } from '../utils/error-message';
import { openErrorSnackBar } from '../utils/error-snackbar';
import { fieldErrorMessage, showIssuesAtFields } from '../utils/form-errors';
import { webhookSchema } from '../utils/schemas';
import { showFieldsToFix } from './field-to-fix.util';
import {
  type AuthFormValue,
  authControlPath,
  buildAuthConfig,
  clearAuthFieldIssuesOnTypeChange,
  toAuthFormValue,
} from './auth-display.util';

/** The fields of an endpoint that is called with an optional API key. */
interface ApiKeyEndpointBody {
  name: string;
  description?: string;
  url: string;
  auth: ReturnType<typeof buildAuthConfig>;
}

/** What the form needs from the service of a webhook endpoint or attribute provider. */
export interface ApiKeyEndpointService {
  getById(id: string): Promise<{
    id: string;
    name: string;
    description?: string | null;
    url: string;
    auth?: unknown;
  }>;
  create(body: ApiKeyEndpointBody & { id: string }): Promise<unknown>;
  update(id: string, body: ApiKeyEndpointBody): Promise<unknown>;
}

/**
 * Create and edit form of an endpoint the backend calls with an optional API
 * key: webhook endpoints and attribute providers.
 */
@Directive()
export abstract class ApiKeyEndpointFormComponent implements OnInit {
  readonly form = new FormGroup({
    id: new FormControl('', [Validators.required]),
    name: new FormControl('', [Validators.required]),
    description: new FormControl(''),
    url: new FormControl('', [Validators.required]),
    authType: new FormControl<AuthFormValue['authType']>('none', [Validators.required]),
    authHeaderName: new FormControl(''),
    authHeaderValue: new FormControl(''),
  });
  create = true;
  /** While a save runs, so a second click does not send it again. */
  saving = false;
  /** While the endpoint to edit loads; saving before would overwrite it with a blank form. */
  loading = false;
  /** Set when the endpoint to edit could not be loaded; the form stays hidden. */
  loadError = '';

  /** The endpoint in messages, such as "webhook endpoint". */
  protected abstract readonly noun: string;
  /** Title of the card with the ID, name, description and URL. */
  protected abstract readonly detailsTitle: string;
  /** Title of the JSON view. */
  protected abstract readonly jsonTitle: string;

  /** Holds the fields; Save focuses the first invalid one. */
  @ViewChild('formElement', { read: ElementRef })
  private readonly formElement?: ElementRef<HTMLFormElement>;
  private readonly injector = inject(Injector);

  constructor(
    private readonly service: ApiKeyEndpointService,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly snackBar: MatSnackBar,
    private readonly dialog: MatDialog
  ) {
    clearAuthFieldIssuesOnTypeChange(this.form);
  }

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.create = false;
      this.load(id);
    }
  }

  retryLoad(): void {
    this.load(this.route.snapshot.paramMap.get('id')!);
  }

  private load(id: string): void {
    this.loading = true;
    this.loadError = '';
    this.service
      .getById(id)
      .then(
        (endpoint) => {
          this.form.patchValue({
            id: endpoint.id,
            name: endpoint.name,
            description: endpoint.description || '',
            url: endpoint.url,
            ...toAuthFormValue(endpoint.auth as Parameters<typeof toAuthFormValue>[0]),
          });
          this.form.controls.id.disable();
        },
        (error) => {
          console.error('Load error:', error);
          this.loadError = getApiErrorMessage(error, `Failed to load ${this.noun}`);
        }
      )
      .finally(() => (this.loading = false));
  }

  /** Save stays focusable while a save runs, so its tooltip says why it waits. */
  get saveTooltip(): string {
    return this.saving ? `Saving the ${this.noun}…` : '';
  }

  onSubmit(): void {
    // `disabledInteractive` keeps Save clickable while it looks disabled.
    if (this.saving || this.loading || this.loadError) return;
    if (this.form.invalid) {
      const { id, name, description, url, authType, authHeaderName, authHeaderValue } =
        this.form.controls;
      showFieldsToFix(this.form, {
        snackBar: this.snackBar,
        injector: this.injector,
        container: () => this.formElement?.nativeElement,
        sections: [
          { name: this.detailsTitle, controls: [id, name, description, url] },
          { name: 'Authentication', controls: [authType, authHeaderName, authHeaderValue] },
        ],
      });
      return;
    }
    this.saving = true;

    const { id, ...body } = this.buildPayload();
    const [verb, request, next] = this.create
      ? (['create', this.service.create({ id, ...body }), ['../']] as const)
      : (() => {
          const routeId = this.route.snapshot.paramMap.get('id')!;
          return ['update', this.service.update(routeId, body), ['../../', routeId]] as const;
        })();
    const label = this.noun.charAt(0).toUpperCase() + this.noun.slice(1);
    request
      .then(() => {
        this.snackBar.open(`${label} ${verb}d successfully`, 'Close', { duration: 3000 });
        this.router.navigate([...next], { relativeTo: this.route });
      })
      .catch((error) => {
        openErrorSnackBar(
          this.snackBar,
          showIssuesAtFields(this.form, error, `Failed to ${verb} ${this.noun}`, authControlPath)
        );
        console.error(`${label} ${verb} error:`, error);
      })
      .finally(() => (this.saving = false));
  }

  /** Message under a field: the backend's issue, else the local validator's message. */
  fieldError(name: string, localMessage = ''): string {
    return fieldErrorMessage(this.form.get(name), localMessage);
  }

  viewAsJson(): void {
    const dialogRef = this.dialog.open(JsonViewDialogComponent, {
      data: {
        title: this.jsonTitle,
        jsonData: this.buildPayload(),
        readonly: false,
        schema: webhookSchema,
      },
      disableClose: true,
      minWidth: '60vw',
      maxWidth: '95vw',
      maxHeight: '95vh',
    });

    dialogRef.afterClosed().subscribe((result) => {
      if (result) {
        this.loadFromJson(result);
      }
    });
  }

  private buildPayload(): ApiKeyEndpointBody & { id: string } {
    const value = this.form.getRawValue();
    return {
      id: value.id ?? '',
      name: value.name ?? '',
      description: value.description || undefined,
      url: value.url ?? '',
      auth: buildAuthConfig({
        authType: value.authType ?? 'none',
        authHeaderName: value.authHeaderName ?? '',
        authHeaderValue: value.authHeaderValue ?? '',
      }),
    };
  }

  private loadFromJson(json: Partial<ApiKeyEndpointBody & { id: string }>): void {
    this.form.patchValue({
      id: json.id || '',
      name: json.name || '',
      description: json.description || '',
      url: json.url || '',
      ...toAuthFormValue(json.auth as Parameters<typeof toAuthFormValue>[0]),
    });
  }
}
