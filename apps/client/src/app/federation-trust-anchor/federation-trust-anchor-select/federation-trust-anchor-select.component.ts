import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  EventEmitter,
  HostListener,
  inject,
  Input,
  OnInit,
  Output,
} from '@angular/core';
import {
  type ControlValueAccessor,
  FormControl,
  NgControl,
  ReactiveFormsModule,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import type { ErrorStateMatcher } from '@angular/material/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { type Params, RouterModule } from '@angular/router';
import { fromFormQueryParams } from '../../common/return-to-form';
import { asSentence, getApiErrorMessage } from '../../utils/error-message';
import {
  type FederationTrustAnchor,
  FederationTrustAnchorService,
} from '../federation-trust-anchor.service';

/**
 * Picks the entity ID of a registered federation trust anchor. An entity ID
 * that is not registered, such as one of a stored configuration, stays
 * selected and is flagged, with a link to register it.
 */
@Component({
  selector: 'app-federation-trust-anchor-select',
  imports: [
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatSelectModule,
    MatTooltipModule,
    ReactiveFormsModule,
    RouterModule,
  ],
  templateUrl: './federation-trust-anchor-select.component.html',
  styleUrl: './federation-trust-anchor-select.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class FederationTrustAnchorSelectComponent implements ControlValueAccessor, OnInit {
  @Input() label = 'Trust anchor';
  /** Emitted when the user picks a registered trust anchor, with the entity ID it replaces. */
  @Output() readonly anchorSelected = new EventEmitter<{
    anchor: FederationTrustAnchor;
    previous: string;
  }>();

  private readonly service = inject(FederationTrustAnchorService);
  private readonly ngControl = inject(NgControl, { self: true, optional: true });
  private readonly destroyRef = inject(DestroyRef);

  /** The select's own control; it reports the state of the bound control as its error state. */
  readonly selection = new FormControl('', { nonNullable: true });
  anchors: FederationTrustAnchor[] = [];
  loading = false;
  loaded = false;
  loadError = '';
  /** The entity ID before the latest pick. */
  private previous = '';
  /** Set when the user opened the registration page, so returning to this tab reloads the list. */
  private registering = false;

  /** The select shows the error of the control this component is bound to. */
  readonly errorStateMatcher: ErrorStateMatcher = {
    isErrorState: () => !!this.ngControl?.invalid && !!this.ngControl?.touched,
  };

  constructor() {
    if (this.ngControl) this.ngControl.valueAccessor = this;
    this.selection.valueChanges.subscribe((entityId) => {
      this.onChange(entityId);
      this.onTouched();
      const anchor = this.anchors.find((a) => a.entityId === entityId);
      if (anchor) this.anchorSelected.emit({ anchor, previous: this.previous });
      this.previous = entityId;
    });
  }

  get value(): string {
    return this.selection.value;
  }

  ngOnInit(): void {
    // A reload by another picker of the page, such as after a registration, updates this one.
    const subscription = this.service.loaded.subscribe((anchors) => {
      this.anchors = anchors;
      this.loaded = true;
      this.loadError = '';
    });
    this.destroyRef.onDestroy(() => subscription.unsubscribe());
    void this.load();
  }

  async load(reload = false): Promise<void> {
    this.loading = true;
    this.loadError = '';
    try {
      this.anchors = await this.service.registeredAnchors(reload);
      this.loaded = true;
    } catch (error) {
      this.loadError = `${asSentence(getApiErrorMessage(error, 'Could not load the registered trust anchors'))} The selected entity ID is kept.`;
    } finally {
      this.loading = false;
    }
  }

  /** After registering a trust anchor in another tab, the user comes back to this one. */
  @HostListener('window:focus')
  onWindowFocus(): void {
    if (!this.registering) return;
    this.registering = false;
    void this.load(true);
  }

  /** True when the list is loaded and the selected entity ID is not in it. */
  get unregistered(): boolean {
    return this.loaded && !!this.value && !this.anchors.some((a) => a.entityId === this.value);
  }

  optionLabel(anchor: FederationTrustAnchor): string {
    return `${anchor.description || anchor.id} (${anchor.entityId})`;
  }

  /**
   * Query parameters of the registration link: an unregistered entity ID is
   * filled in, and the page says to return here once the trust anchor exists.
   */
  get registerQueryParams(): Params {
    return fromFormQueryParams(this.unregistered ? { entityId: this.value } : {});
  }

  openRegistration(): void {
    this.registering = true;
  }

  writeValue(value: unknown): void {
    this.previous = typeof value === 'string' ? value : '';
    this.selection.setValue(this.previous, { emitEvent: false });
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    if (disabled) this.selection.disable({ emitEvent: false });
    else this.selection.enable({ emitEvent: false });
  }

  /** A locked configuration offers no registration or reload next to its trust anchor. */
  get disabled(): boolean {
    return this.selection.disabled;
  }

  markTouched(): void {
    this.onTouched();
  }

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};
}
