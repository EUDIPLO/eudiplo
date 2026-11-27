import {
  DoCheck,
  Directive,
  ElementRef,
  HostBinding,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Optional,
  Self,
} from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { JwtService, type Role } from '../services/jwt.service';

/**
 * Why the caller cannot use an action: it lacks every one of `roles`.
 * For example "Needs the issuance:manage or presentation:manage role".
 */
export function missingRoleReason(roles: Role | readonly Role[]): string {
  const list = typeof roles === 'string' ? [roles] : [...roles];
  return `Needs the ${list.join(' or ')} role`;
}

/** A middle click or the context menu would open a locked link in a new tab. */
const BLOCKED_EVENTS = ['click', 'auxclick', 'contextmenu'] as const;

/**
 * Locks an action that needs a role the caller does not have, such as Edit
 * for a caller that may only read. The action stays focusable and its tooltip
 * or description names the role, as for `appConfigManaged`, whose lock this
 * one replaces on the same host: a caller who cannot change a resource does not
 * need to know that a file manages it. Use it on Material buttons and links.
 * The backend has the final say.
 */
@Directive({
  selector: '[appRequiresRole]',
  standalone: true,
})
export class RoleLockDirective implements OnInit, OnChanges, DoCheck, OnDestroy {
  /** The roles that allow the action; one of them is enough. */
  @Input({ required: true }) appRequiresRole: Role | readonly Role[] = [];
  /** The host's own tooltip, which names the action. The lock reason is added to it. */
  @Input() matTooltip?: string | null;

  constructor(
    private readonly jwtService: JwtService,
    private readonly host: ElementRef<HTMLElement>,
    @Optional() @Self() private readonly tooltip: MatTooltip | null,
    @Optional() @Self() matButton: MatButton | null,
    @Optional() @Self() matIconButton: MatIconButton | null
  ) {
    this.button = matButton ?? matIconButton;
  }

  private readonly button: Pick<MatButton, 'ariaDisabled'> | null;

  /** Whether the caller lacks every role that allows the action. */
  get locked(): boolean {
    const roles =
      typeof this.appRequiresRole === 'string' ? [this.appRequiresRole] : [...this.appRequiresRole];
    return roles.length > 0 && !this.jwtService.hasRole(roles);
  }

  get reason(): string {
    return missingRoleReason(this.appRequiresRole);
  }

  /** Read by screen readers when the host has no tooltip; a tooltip's description takes precedence. */
  @HostBinding('attr.aria-description') get ariaDescription(): string | null {
    return this.locked && !this.tooltip ? this.reason : null;
  }

  /** The browser's tooltip for a host without a Material one. */
  @HostBinding('attr.title') get title(): string | null {
    return this.locked && !this.tooltip ? this.reason : null;
  }

  /** Material's look for a disabled button that stays interactive, as `disabledInteractive` gives. */
  @HostBinding('class.role-locked-action')
  @HostBinding('class.mat-mdc-button-disabled')
  get lockedClass(): true | undefined {
    return this.locked || undefined;
  }

  /** A host disabled for another reason keeps Material's `pointer-events: none`. */
  @HostBinding('class.mat-mdc-button-disabled-interactive')
  get interactiveClass(): true | undefined {
    return (this.locked && !this.host.nativeElement.hasAttribute('disabled')) || undefined;
  }

  ngOnInit(): void {
    for (const type of BLOCKED_EVENTS) {
      this.host.nativeElement.addEventListener(type, this.preventLockedAction, true);
    }
  }

  ngOnDestroy(): void {
    for (const type of BLOCKED_EVENTS) {
      this.host.nativeElement.removeEventListener(type, this.preventLockedAction, true);
    }
  }

  ngOnChanges(): void {
    // The host's tooltip has just received the plain action name as well.
    this.sync();
  }

  /** The caller's roles can change while the page stays, for example after a token renewal. */
  ngDoCheck(): void {
    if (this.locked !== this.syncedLocked) this.sync();
  }

  /** The lock state that `aria-disabled` and the tooltip show. */
  private syncedLocked?: boolean;

  /**
   * Runs in the capture phase, before the host's own (click) and RouterLink
   * handlers. Enter and Space on a focused button arrive here as a click too.
   */
  private readonly preventLockedAction = (event: Event): void => {
    if (!this.locked) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private sync(): void {
    const locked = this.locked;
    this.syncedLocked = locked;
    if (this.button) {
      this.button.ariaDisabled = locked || undefined;
    } else if (locked) {
      this.host.nativeElement.setAttribute('aria-disabled', 'true');
    } else {
      this.host.nativeElement.removeAttribute('aria-disabled');
    }
    if (!this.tooltip) return;
    if (!locked) {
      this.tooltip.message = this.matTooltip;
      return;
    }
    const action = this.matTooltip?.trim();
    this.tooltip.message = action ? `${action}. ${this.reason}` : this.reason;
  }
}
