import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  ViewChild,
} from '@angular/core';
import {
  type AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidationErrors,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import type { CreateFederationTrustAnchorDto } from '@eudiplo/sdk-core';
import { FlexLayoutModule } from 'ngx-flexible-layout';
import { focusAfterRenderIfLost } from '../../common/focus-if-lost.util';
import { LoadErrorComponent } from '../../common/load-error.component';
import { type CreatedForForm, openedFromForm } from '../../common/return-to-form';
import { ReturnToFormComponent } from '../../common/return-to-form.component';
import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipNoticeComponent } from '../../config-portability/config-ownership-notice.component';
import { EditorComponent } from '../../utils/editor/editor.component';
import { getApiErrorMessage, hasHttpStatus } from '../../utils/error-message';
import { openErrorSnackBar } from '../../utils/error-snackbar';
import { fieldErrorMessage, showIssuesAtFields } from '../../utils/form-errors';
import { schemaFormValidator } from '../../utils/schema-form-validator';
import { federationTrustAnchorJwksSchema } from '../../utils/schemas';
import {
  FederationTrustAnchorService,
  isFederationEntityId,
} from '../federation-trust-anchor.service';
import { FederationTrustAnchorReferences } from '../federation-trust-anchor-references';

/** Accepts an Entity Identifier as the backend does; an empty value passes. */
function entityIdValidator(control: AbstractControl): ValidationErrors | null {
  const value = `${control.value ?? ''}`.trim();
  return !value || isFederationEntityId(value) ? null : { entityId: true };
}

type JwksValue = CreateFederationTrustAnchorDto['jwks'];

@Component({
  selector: 'app-federation-trust-anchor-edit',
  imports: [
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSnackBarModule,
    MatTooltipModule,
    FlexLayoutModule,
    ReactiveFormsModule,
    RouterModule,
    EditorComponent,
    ConfigOwnershipDirective,
    ConfigOwnershipNoticeComponent,
    LoadErrorComponent,
    ReturnToFormComponent,
  ],
  templateUrl: './federation-trust-anchor-edit.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './federation-trust-anchor-edit.component.scss',
  providers: [FederationTrustAnchorReferences],
})
export class FederationTrustAnchorEditComponent implements OnInit {
  readonly jwksSchema = federationTrustAnchorJwksSchema;
  readonly editorOptions = { language: 'json', automaticLayout: true, minimap: { enabled: false } };

  readonly form = new FormGroup({
    id: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.maxLength(255),
        Validators.pattern(/^[A-Za-z0-9._-]+$/),
      ],
    }),
    entityId: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(2048), entityIdValidator],
    }),
    description: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(1000)],
    }),
    // The editor writes the text itself while it is not valid JSON.
    jwks: new FormControl<JwksValue | string | null>(null, {
      validators: [Validators.required, schemaFormValidator(federationTrustAnchorJwksSchema)],
    }),
  });

  private readonly references = inject(FederationTrustAnchorReferences);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  @ViewChild('pageHeading') private readonly pageHeading?: ElementRef<HTMLElement>;
  /** Entity ID of the trust anchor as stored, which configurations may name. */
  private storedEntityId = '';

  /** ID of the trust anchor being edited; unset when registering a new one. */
  anchorId: string | null = null;
  loading = false;
  /** Set when the trust anchor to edit could not be loaded, so no empty form is shown. */
  loadError = '';
  /** While a save runs, so a second click does not send it again. */
  saving = false;
  /** Set when a configuration screen in another tab opened this page to register a trust anchor. */
  private openedFromForm = false;
  /** The trust anchor registered for that screen; the page then says to return to its tab. */
  registeredForForm: CreatedForForm | null = null;

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly snackBar: MatSnackBar,
    private readonly service: FederationTrustAnchorService
  ) {}

  get isEditMode(): boolean {
    return !!this.anchorId;
  }

  ngOnInit(): void {
    this.anchorId = this.route.snapshot.paramMap.get('id');
    if (this.anchorId) {
      this.form.controls.id.disable();
      void this.load();
      return;
    }
    // The configuration screens link here with the entity ID they could not find.
    const entityId = this.route.snapshot.queryParamMap.get('entityId');
    if (entityId) this.form.controls.entityId.setValue(entityId);
    this.openedFromForm = openedFromForm(this.route.snapshot.queryParamMap);
  }

  async load(): Promise<void> {
    if (!this.anchorId) return;
    const retrying = this.loadError !== '';
    this.loading = true;
    this.loadError = '';
    try {
      const anchor = await this.service.getById(this.anchorId);
      this.storedEntityId = anchor.entityId;
      void this.references.load(anchor.entityId);
      this.form.patchValue({
        id: anchor.id,
        entityId: anchor.entityId,
        description: anchor.description ?? '',
        jwks: anchor.jwks as JwksValue,
      });
    } catch (error) {
      this.loadError = getApiErrorMessage(error, 'Failed to load the trust anchor');
    } finally {
      this.loading = false;
    }
    // The retry removed the error card with its focused Retry button.
    if (retrying && !this.loadError)
      focusAfterRenderIfLost(this.injector, () => this.pageHeading?.nativeElement);
  }

  async onSubmit(): Promise<void> {
    if (this.saving) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.snackBar.open('Check the highlighted fields', 'Close', { duration: 3000 });
      return;
    }
    // The backend refuses an entity ID change while configurations name the stored one.
    if (this.entityIdChangeBlocked) {
      openErrorSnackBar(this.snackBar, this.entityIdChangeWarning);
      return;
    }
    const value = this.form.getRawValue();
    // The form is valid, so the editor holds a parsed JWK set, maybe with its schema reference.
    const jwks = { ...(value.jwks as JwksValue) };
    delete (jwks as { $schema?: unknown }).$schema;
    const body = {
      entityId: value.entityId.trim(),
      description: value.description.trim() || null,
      jwks,
    };

    this.saving = true;
    try {
      const saved = this.anchorId
        ? await this.service.update(this.anchorId, body)
        : await this.service.create({ id: value.id.trim(), ...body });
      // The configuration screen waits in its own tab; this one does not move elsewhere.
      if (this.openedFromForm) {
        const heading = `Trust anchor "${saved.description || saved.id}" registered`;
        // A user who left the page meanwhile gets the outcome where they are.
        if (this.destroyRef.destroyed) {
          this.snackBar.open(`${heading}.`, 'Close', { duration: 5000 });
        } else {
          this.registeredForForm = { id: saved.id, heading };
        }
        return;
      }
      this.snackBar.open(
        this.anchorId ? 'Trust anchor updated' : 'Trust anchor registered',
        'Close',
        { duration: 3000 }
      );
      await this.router.navigate(['/federation-trust-anchor', saved.id]);
    } catch (error) {
      openErrorSnackBar(
        this.snackBar,
        showIssuesAtFields(
          this.form,
          error,
          this.anchorId
            ? 'Failed to update the trust anchor'
            : 'Failed to register the trust anchor',
          // The JWK set is one editor, so its issues are shown there.
          (path) => (path.startsWith('jwks.') ? 'jwks' : path)
        )
      );
      // The backend found configurations naming the stored entity ID; show its current state.
      if (hasHttpStatus(error, 409) && this.storedEntityId)
        void this.references.load(this.storedEntityId);
    } finally {
      this.saving = false;
    }
  }

  /** Message under a field: the backend's issue, else the local validator's message. */
  fieldError(path: keyof typeof this.form.controls, localMessage = ''): string {
    return fieldErrorMessage(this.form.get(path), localMessage);
  }

  get idError(): string {
    const control = this.form.controls.id;
    if (control.hasError('required')) return 'ID is required';
    if (control.hasError('pattern')) return "Use only letters, digits, '.', '_' and '-'";
    if (control.hasError('maxlength')) return 'Use at most 255 characters';
    return this.fieldError('id');
  }

  get entityIdError(): string {
    const control = this.form.controls.entityId;
    if (control.hasError('required')) return 'Entity ID is required';
    if (control.hasError('entityId') || control.hasError('maxlength'))
      return 'Enter an https URL with a host and without query or fragment';
    return this.fieldError('entityId');
  }

  /**
   * Shown while the entity ID differs from the stored one: the backend refuses the change while
   * a configuration names the stored entity ID, so the warning says how to move.
   */
  get entityIdChangeWarning(): string {
    if (!this.entityIdChanged) return '';
    const uses = this.references.describe();
    const refused = uses
      ? `${this.storedEntityId} is named by ${uses}, so the change is refused.`
      : `If a configuration names ${this.storedEntityId}, the change is refused.`;
    return `${refused} To move, register the new entity ID as another trust anchor and switch the configurations to it.`;
  }

  /** True while the entity ID differs from the stored one. */
  private get entityIdChanged(): boolean {
    const entityId = this.form.controls.entityId.value.trim();
    return !!this.storedEntityId && !!entityId && entityId !== this.storedEntityId;
  }

  /** True when the entity ID changed and this page sees configurations naming the stored one. */
  get entityIdChangeBlocked(): boolean {
    return this.entityIdChanged && !!this.references.describe();
  }

  /** The backend's issue with the keys; the editor shows the local validation messages. */
  get jwksError(): string {
    return this.fieldError('jwks');
  }
}
