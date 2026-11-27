import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import type { OidcClientResponseDto } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeListStates } from '../../common/base-async-list.testing';
import { JwtService } from '../../services/jwt.service';
import { OidcClientService } from '../oidc-client.service';
import { OidcClientListComponent } from './oidc-client-list.component';
import { grantEveryRole } from '../../common/role-lock.testing';
import { effectiveRoles } from '../../services/role-grants';

// The tests are about what the actions do; role locks have their own tests.
beforeEach(() => grantEveryRole());

const portal = {
  id: 'c7d1',
  name: 'Customer Portal',
  redirectUris: ['https://portal.example/cb'],
  profile: 'secure',
  scopes: [{ scope: 'pid', presentationConfigId: 'pid' }],
  secrets: [],
  issuer: 'https://eudiplo.example/verifiers/root/oidc',
} as unknown as OidcClientResponseDto;

const broker = {
  ...portal,
  id: 'a9f2',
  name: 'Auth broker',
  profile: 'basic',
  scopes: [{ scope: 'mdl', presentationConfigId: 'mdl' }],
} as unknown as OidcClientResponseDto;

describe('OidcClientListComponent', () => {
  describeListStates({
    component: OidcClientListComponent,
    service: OidcClientService,
    fetchMethod: 'getAll',
    item: portal as never,
    loading: 'Loading OIDC clients',
    empty: 'No OIDC clients yet.',
    create: 'Create OIDC client',
    heading: 'h1',
    firstCell: 'Customer Portal',
    failure: 'Failed to load OIDC clients',
  });

  describe('with clients', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      TestBed.resetTestingModule();
    });

    async function render(
      service: Partial<OidcClientService>,
      roles: string[] = ['presentation:manage']
    ) {
      const snackBar = { open: vi.fn() };
      TestBed.configureTestingModule({
        imports: [OidcClientListComponent],
        providers: [
          provideRouter([]),
          {
            provide: OidcClientService,
            useValue: { getAll: async () => [portal, broker], ...service },
          },
          { provide: MatSnackBar, useValue: snackBar },
          {
            provide: JwtService,
            useValue: {
              hasRole: (role: string | string[]) =>
                [role].flat().some((r) => effectiveRoles(roles).includes(r)),
            },
          },
        ],
      });
      const fixture = TestBed.createComponent(OidcClientListComponent);
      fixture.detectChanges();
      const page = fixture.nativeElement as HTMLElement;
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(page.querySelectorAll('a.item-link')).toHaveLength(2);
      });
      return { fixture, page, component: fixture.componentInstance, snackBar };
    }

    const names = (page: HTMLElement) =>
      [...page.querySelectorAll('a.item-link')].map((link) => link.textContent?.trim());

    it('lists the clients by name, each linked to its page, with profile and scopes', async () => {
      const { page } = await render({});
      const rows = [...page.querySelectorAll('tr.mat-mdc-row')];

      expect(names(page)).toEqual(['Auth broker', 'Customer Portal']);
      expect(rows[1].querySelector('a.item-link')?.getAttribute('href')).toBe('/c7d1');
      expect(rows[1].querySelector('.client-id')?.textContent?.trim()).toBe('c7d1');
      expect(rows.map((row) => row.querySelector('.badge')?.textContent?.trim())).toEqual([
        'Basic',
        'Secure (PAR required)',
      ]);
      expect(rows[0].querySelector('.role-badge')?.textContent?.trim()).toBe('mdl');
      expect(page.querySelector('.table-title output')?.textContent?.trim()).toBe('2 clients');
    });

    it('finds clients by client ID or scope and says when none matches', async () => {
      const { fixture, page } = await render({});
      const field = page.querySelector<HTMLInputElement>('input[type="search"]')!;
      const type = (value: string) => {
        field.value = value;
        field.dispatchEvent(new Event('input'));
        fixture.detectChanges();
      };

      type('C7D');
      expect(names(page)).toEqual(['Customer Portal']);
      expect(page.querySelector('.table-title output')?.textContent?.trim()).toBe('1 of 2 clients');
      type('mdl');
      expect(names(page)).toEqual(['Auth broker']);
      type('nobody');
      expect(page.querySelector('.no-match')?.textContent).toContain('No client matches "nobody".');
    });

    it('deletes a client once after confirmation and removes its row', async () => {
      let finish!: () => void;
      const remove = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
      const { fixture, page, component, snackBar } = await render({ delete: remove as never });
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      const deleting = component.deleteClient(portal);
      fixture.detectChanges();
      expect(page.querySelectorAll('button.delete-action')[1].getAttribute('aria-disabled')).toBe(
        'true'
      );
      await component.deleteClient(portal);
      expect(remove).toHaveBeenCalledTimes(1);

      finish();
      await deleting;
      fixture.detectChanges();
      expect(remove).toHaveBeenCalledWith('c7d1');
      expect(snackBar.open).toHaveBeenCalledWith('OIDC client deleted', 'Close', {
        duration: 3000,
      });
      expect(names(page)).toEqual(['Auth broker']);
    });

    it('keeps the client and says why when the delete fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { fixture, page, component, snackBar } = await render({
        delete: vi.fn().mockRejectedValue({ statusCode: 500, message: 'x' }),
      });
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await component.deleteClient(portal);
      fixture.detectChanges();

      expect(snackBar.open.mock.calls.at(-1)?.[0]).toBe('Failed to delete OIDC client: x');
      expect(names(page)).toEqual(['Auth broker', 'Customer Portal']);
      expect(
        page.querySelectorAll('button.delete-action')[1].getAttribute('aria-disabled')
      ).not.toBe('true');
    });

    it('deletes nothing when the confirmation is declined', async () => {
      const remove = vi.fn(async () => undefined);
      const { component } = await render({ delete: remove as never });
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      await component.deleteClient(portal);

      expect(remove).not.toHaveBeenCalled();
    });
  });
});
