import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { provideRouter, Router, RouterLink } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipDirective } from '../config-portability/config-ownership.directive';
import { ConfigOwnershipService } from '../config-portability/config-ownership.service';
import { JwtService, type Role } from '../services/jwt.service';
import { effectiveRoles } from '../services/role-grants';
import { missingRoleReason, RoleLockDirective } from './role-lock.directive';
import { expectAvailable, expectUnavailable } from './unavailable-action.testing';

@Component({
  imports: [
    MatButtonModule,
    MatTooltipModule,
    RouterLink,
    RoleLockDirective,
    ConfigOwnershipDirective,
  ],
  template: `
    <button
      id="delete"
      matIconButton
      matTooltip="Delete"
      aria-label="Delete"
      [appRequiresRole]="writeRoles"
      (click)="deleted = deleted + 1"
    >
      x
    </button>
    <a id="create" matButton routerLink="/create" [appRequiresRole]="writeRoles">Create</a>
    <button
      id="edit"
      matButton
      matTooltip="Edit"
      [appRequiresRole]="writeRoles"
      appConfigManaged
      managedKind="TrustList"
      managedResourceId="list"
      (click)="edited = edited + 1"
    >
      Edit
    </button>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
})
class HostComponent {
  readonly writeRoles: Role[] = ['issuance:manage', 'presentation:manage'];
  deleted = 0;
  edited = 0;
}

function render(initialRoles: string[], managed = false) {
  const caller = { roles: initialRoles };
  const ownership = vi.fn(async () =>
    managed ? { ownership: 'file-managed', source: 'lists.json' } : undefined
  );
  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [
      provideRouter([]),
      {
        provide: JwtService,
        useValue: {
          hasRole: (role: Role | Role[]) =>
            [role].flat().some((r) => effectiveRoles(caller.roles).includes(r)),
        },
      },
      { provide: ConfigOwnershipService, useValue: { get: ownership } },
    ],
  });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    caller,
    ownership,
    deleteButton: element.querySelector<HTMLButtonElement>('#delete')!,
    create: element.querySelector<HTMLAnchorElement>('#create')!,
    edit: element.querySelector<HTMLButtonElement>('#edit')!,
  };
}

describe('missingRoleReason', () => {
  it('names the role, or each of the roles that allow the action', () => {
    expect(missingRoleReason('keys:manage')).toBe('Needs the keys:manage role');
    expect(missingRoleReason(['issuance:manage', 'presentation:manage'])).toBe(
      'Needs the issuance:manage or presentation:manage role'
    );
  });
});

describe('RoleLockDirective', () => {
  it('locks an action for a caller without the role, keeps it focusable and says why', () => {
    const { fixture, deleteButton } = render(['issuance:read']);

    expectUnavailable(
      fixture,
      deleteButton as HTMLButtonElement,
      'Delete. Needs the issuance:manage or presentation:manage role'
    );
    deleteButton.click();
    expect(fixture.componentInstance.deleted).toBe(0);
  });

  it('keeps the action of a caller with one of the roles, or a role that includes it', () => {
    const { fixture, deleteButton } = render(['presentation:manage']);

    expectAvailable(fixture, deleteButton, 'Delete');
    deleteButton.click();
    expect(fixture.componentInstance.deleted).toBe(1);

    TestBed.resetTestingModule();
    // tenant:admin includes both manage roles.
    const admin = render(['tenant:admin']);
    expectAvailable(admin.fixture, admin.deleteButton, 'Delete');
  });

  it('keeps a locked link from navigating and describes it without a tooltip', async () => {
    const { create } = render(['issuance:read']);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');

    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(create.getAttribute('aria-description')).toBe(
      'Needs the issuance:manage or presentation:manage role'
    );
    expect(create.getAttribute('title')).toBe(
      'Needs the issuance:manage or presentation:manage role'
    );
    create.click();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('takes the place of the lock of a file-managed resource and skips its lookup', async () => {
    const { fixture, edit, ownership } = render(['issuance:read'], true);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(ownership).not.toHaveBeenCalled();
    expectUnavailable(fixture, edit, 'Edit. Needs the issuance:manage or presentation:manage role');
    edit.click();
    expect(fixture.componentInstance.edited).toBe(0);
  });

  it('leaves a caller with the role to the lock of a file-managed resource', async () => {
    const { fixture, edit, ownership } = render(['issuance:manage'], true);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(edit.getAttribute('aria-busy')).toBeNull();
    });

    expect(ownership).toHaveBeenCalledWith('TrustList', 'list');
    expectUnavailable(fixture, edit, 'Edit. Managed by lists.json, read-only');
  });

  // The caller's roles can change while the page stays, for example after a token renewal.
  it('follows a role that is lost or gained while the page stays', async () => {
    const { fixture, caller, deleteButton, edit, ownership } = render(['issuance:manage'], true);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(edit.getAttribute('aria-busy')).toBeNull();
    });
    expectAvailable(fixture, deleteButton, 'Delete');

    caller.roles = ['issuance:read'];
    fixture.detectChanges();

    expectUnavailable(
      fixture,
      deleteButton,
      'Delete. Needs the issuance:manage or presentation:manage role'
    );
    expectUnavailable(fixture, edit, 'Edit. Needs the issuance:manage or presentation:manage role');

    caller.roles = ['issuance:manage'];
    ownership.mockClear();
    fixture.detectChanges();

    expectAvailable(fixture, deleteButton, 'Delete');
    // The lock of the file-managed resource comes back once its lookup has answered.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(edit.getAttribute('aria-busy')).toBeNull();
    });
    expect(ownership).toHaveBeenCalledOnce();
    expectUnavailable(fixture, edit, 'Edit. Managed by lists.json, read-only');
  });
});
