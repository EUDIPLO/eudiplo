import {
  ChangeDetectorRef,
  Directive,
  ElementRef,
  HostBinding,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Optional,
  Self,
  SimpleChanges,
} from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { ConfigOwnershipService, ConfigResourceKind } from './config-ownership.service';

/** A middle click or the context menu would open a locked link in a new tab. */
const BLOCKED_EVENTS = ['click', 'auxclick', 'contextmenu'] as const;

/**
 * Locks an action of a file-managed resource. The action stays focusable and
 * hoverable so that its tooltip and description can say why it is locked.
 * Use it on Material buttons and links: the locked look comes from their
 * classes.
 */
@Directive({
  selector: '[appConfigManaged]',
  standalone: true,
})
export class ConfigOwnershipDirective implements OnInit, OnChanges, OnDestroy {
  @Input({ required: true }) managedKind!: ConfigResourceKind;
  @Input({ required: true }) managedResourceId = '';
  /** The host's own tooltip, which names the action. The lock reason is added to it. */
  @Input() matTooltip?: string | null;

  managed = false;
  /** File or bundle that provisioned the resource. */
  private source?: string;
  /** While the lookup runs (at most 10 s), clicks are held back so they cannot get past a lock. */
  pending = false;
  @HostBinding('attr.aria-busy') get ariaBusy(): string | null {
    return this.pending ? 'true' : null;
  }
  /** Read by screen readers when the host has no tooltip; a tooltip's description takes precedence. */
  @HostBinding('attr.aria-description') get ariaDescription(): string | null {
    return this.managed ? this.lockReason : null;
  }
  /**
   * The browser's tooltip for a host without a Material one, such as Save at the
   * end of a long form whose lock notice has scrolled away.
   */
  @HostBinding('attr.title') get title(): string | null {
    return this.managed && !this.tooltip ? this.lockReason : null;
  }
  /**
   * Material's look for a disabled button that stays interactive, as its
   * `disabledInteractive` input gives. The host's `disabled` input belongs to
   * its template, so the directive sets Material's classes itself. `undefined`
   * leaves an unlocked host to the button's own bindings; `false` would
   * remove Material's class from a button that is disabled for another reason.
   */
  @HostBinding('class.config-managed-action')
  @HostBinding('class.mat-mdc-button-disabled')
  get managedClass(): true | undefined {
    return this.managed || undefined;
  }
  /**
   * A host disabled for another reason keeps Material's `pointer-events: none`,
   * so its own explanation, such as a wrapper's tooltip, stays the only one.
   */
  @HostBinding('class.mat-mdc-button-disabled-interactive')
  get interactiveClass(): true | undefined {
    return (this.managed && !this.host.nativeElement.hasAttribute('disabled')) || undefined;
  }
  @HostBinding('style.cursor') get cursor(): string | null {
    return this.pending ? 'progress' : null;
  }

  private get lockReason(): string {
    const reason = `Managed by ${this.source || 'a configuration bundle'}, read-only`;
    // Screens such as the key list change a tenant setting without naming the tenant resource.
    return this.managedKind === 'Tenant'
      ? `${reason}. To change it, detach Tenant/tenant under Settings > Config Portability`
      : reason;
  }

  private request = 0;
  /**
   * A Material button binds `aria-disabled` itself, for example for
   * `disabledInteractive`. A second binding on the same attribute would
   * overwrite it whenever its own value changes, so the lock goes through the
   * button's `ariaDisabled` input instead.
   */
  private readonly button: Pick<MatButton, 'ariaDisabled'> | null;

  constructor(
    private readonly ownership: ConfigOwnershipService,
    private readonly changeDetector: ChangeDetectorRef,
    private readonly host: ElementRef<HTMLElement>,
    @Optional() @Self() private readonly tooltip: MatTooltip | null,
    @Optional() @Self() matButton: MatButton | null,
    @Optional() @Self() matIconButton: MatIconButton | null
  ) {
    this.button = matButton ?? matIconButton;
  }

  ngOnInit(): void {
    for (const type of BLOCKED_EVENTS) {
      this.host.nativeElement.addEventListener(type, this.preventManagedMutation, true);
    }
  }

  ngOnDestroy(): void {
    for (const type of BLOCKED_EVENTS) {
      this.host.nativeElement.removeEventListener(type, this.preventManagedMutation, true);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    // The host's tooltip has just received the plain action name as well.
    this.syncTooltip();
    if (changes['managedKind'] || changes['managedResourceId']) {
      void this.refresh();
    }
  }

  /**
   * Runs in the capture phase, before the host's own (click) and RouterLink
   * handlers. Enter and Space on a focused button arrive here as a click too.
   */
  private readonly preventManagedMutation = (event: Event): void => {
    if (!this.managed && !this.pending) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private syncAriaDisabled(): void {
    if (this.button) {
      this.button.ariaDisabled = this.managed || undefined;
    } else if (this.managed) {
      this.host.nativeElement.setAttribute('aria-disabled', 'true');
    } else {
      this.host.nativeElement.removeAttribute('aria-disabled');
    }
  }

  private syncTooltip(): void {
    if (!this.tooltip) return;
    if (!this.managed) {
      this.tooltip.message = this.matTooltip;
      return;
    }
    const action = this.matTooltip?.trim();
    this.tooltip.message = action ? `${action}. ${this.lockReason}` : this.lockReason;
  }

  private async refresh(): Promise<void> {
    const request = ++this.request;
    if (!this.managedKind || !this.managedResourceId) {
      this.managed = false;
      this.pending = false;
      this.syncAriaDisabled();
      this.syncTooltip();
      return;
    }
    this.pending = true;
    try {
      const ownership = await this.ownership.get(this.managedKind, this.managedResourceId);
      if (request !== this.request) return;
      this.managed = ownership?.ownership === 'file-managed';
      this.source = ownership?.source;
    } catch {
      // The backend remains authoritative if ownership metadata cannot be loaded.
    } finally {
      if (request === this.request) {
        this.pending = false;
        this.syncAriaDisabled();
        this.syncTooltip();
        this.changeDetector.markForCheck();
      }
    }
  }
}
