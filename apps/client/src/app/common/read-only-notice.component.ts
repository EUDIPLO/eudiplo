import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import type { Role } from '../services/jwt.service';
import { missingRoleReason } from './role-lock.directive';

/**
 * Says above a form that the caller can read but not change it, because it
 * lacks every one of `roles`. The form itself is disabled, so nothing the
 * caller cannot save counts as an unsaved change.
 */
@Component({
  selector: 'app-read-only-notice',
  standalone: true,
  imports: [MatIconModule],
  template: `
    <p class="read-only-notice" role="note">
      <mat-icon aria-hidden="true">lock</mat-icon>
      <span>Read-only: {{ message }}</span>
    </p>
  `,
  styleUrl: './read-only-notice.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReadOnlyNoticeComponent {
  /** What the form changes, such as "these settings". */
  @Input({ required: true }) subject = '';
  /** The roles that may change it; one of them is enough. */
  @Input({ required: true }) roles: Role | readonly Role[] = [];

  get message(): string {
    // "Needs the issuance:manage role" -> "changing these settings needs the issuance:manage role."
    return `changing ${this.subject} ${missingRoleReason(this.roles).replace(/^Needs/, 'needs')}.`;
  }
}
