import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import type { StatusListResponseDto } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeListStates } from '../../common/base-async-list.testing';
import { expectAvailable, expectUnavailable } from '../../common/unavailable-action.testing';
import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { JwtService } from '../../services/jwt.service';
import { StatusListManagementService } from '../status-list-management.service';
import { StatusListListComponent } from './status-list-list.component';

function statusList(
  id: string,
  fields: Partial<StatusListResponseDto> = {}
): StatusListResponseDto {
  return {
    id,
    uri: `https://issuer.example/status/${id}`,
    bits: 1,
    capacity: 10000,
    usedEntries: 0,
    availableEntries: 10000,
    createdAt: '2026-01-01T00:00:00Z',
    ...fields,
  } as StatusListResponseDto;
}

describe('StatusListListComponent', () => {
  describeListStates({
    component: StatusListListComponent,
    service: StatusListManagementService,
    fetchMethod: 'getLists',
    item: statusList('list-1'),
    loading: 'Loading status lists',
    empty: 'No status lists yet.',
    create: 'Create status list',
    failure: 'Failed to load status lists',
    providers: [
      { provide: JwtService, useValue: { hasRole: () => true } },
      { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
    ],
  });
});

describe('StatusListListComponent table', () => {
  const lists = [
    statusList('shared-b', { keyChainId: 'status-keys' }),
    statusList('pid-a', { credentialConfigurationId: 'pid', usedEntries: 3 }),
  ];

  async function render(
    service: Partial<StatusListManagementService>,
    roles = ['issuance:manage']
  ) {
    TestBed.configureTestingModule({
      imports: [StatusListListComponent],
      providers: [
        provideRouter([]),
        {
          provide: StatusListManagementService,
          useValue: service,
        },
        { provide: JwtService, useValue: { hasRole: (role: string) => roles.includes(role) } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    });
    const fixture = TestBed.createComponent(StatusListListComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.loading).toBe(false));
    fixture.detectChanges();
    return fixture;
  }

  const ids = (element: HTMLElement) =>
    [...element.querySelectorAll('.item-link')].map((link) => link.textContent?.trim());

  const deleteButton = (element: HTMLElement, id: string) =>
    element.querySelector<HTMLButtonElement>(`button[aria-label="Delete status list ${id}"]`)!;

  afterEach(() => vi.restoreAllMocks());

  it('sorts by ID, links each ID to its list and narrows the rows to the search', async () => {
    const fixture = await render({ getLists: async () => lists });
    const element = fixture.nativeElement as HTMLElement;

    expect(ids(element)).toEqual(['pid-a', 'shared-b']);
    expect(element.querySelector('.item-link')?.getAttribute('href')).toBe('/pid-a');
    expect(element.querySelector('output')?.textContent?.trim()).toBe('2 status lists');
    expect(element.querySelector('a[href="/config"]')?.textContent).toContain('Default settings');

    fixture.componentInstance.search = 'status-keys';
    fixture.detectChanges();
    expect(ids(element)).toEqual(['shared-b']);
    expect(element.querySelector('output')?.textContent?.trim()).toBe('1 of 2 status lists');

    fixture.componentInstance.search = 'PID';
    fixture.detectChanges();
    expect(ids(element)).toEqual(['pid-a']);

    fixture.componentInstance.search = 'nothing';
    fixture.detectChanges();
    expect(element.querySelector('.no-match')?.textContent).toContain(
      'No status list matches "nothing".'
    );
  });

  it('shows the binding, the key chain and the JWT status as badges', async () => {
    const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const fixture = await render({
      getLists: async () => [
        statusList('a', { credentialConfigurationId: 'pid', expiresAt: soon }),
        statusList('b', { expiresAt: '2000-01-01T00:00:00Z' }),
      ],
    });
    const rows = [...(fixture.nativeElement as HTMLElement).querySelectorAll('tr.mat-mdc-row')];

    expect(rows[0].querySelector('.mat-column-credentialConfigurationId .badge')?.textContent).toBe(
      'pid'
    );
    expect(rows[0].querySelector('.mat-column-expiresAt .badge.status-warning')?.textContent).toBe(
      'Expiring'
    );
    expect(rows[1].querySelector('.mat-column-credentialConfigurationId')?.textContent).toContain(
      'Shared'
    );
    expect(rows[1].querySelector('.mat-column-keyChainId')?.textContent).toContain('Default');
    expect(rows[1].querySelector('.mat-column-expiresAt .badge.status-danger')?.textContent).toBe(
      'Expired'
    );
  });

  it('deletes an unused list from its row after confirming and loads the list again', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteList = vi.fn().mockResolvedValue(undefined);
    const getLists = vi.fn().mockResolvedValueOnce(lists).mockResolvedValueOnce([lists[1]]);
    const fixture = await render({ getLists, deleteList });
    const element = fixture.nativeElement as HTMLElement;

    const remove = deleteButton(element, 'shared-b');
    expectAvailable(fixture, remove, 'Delete status list');
    remove.click();

    await vi.waitFor(() => expect(getLists).toHaveBeenCalledTimes(2));
    expect(window.confirm).toHaveBeenCalledWith(
      'Delete status list "shared-b"? This cannot be undone.'
    );
    expect(deleteList).toHaveBeenCalledWith('shared-b');
  });

  it('refuses to delete a list with entries in use and says why', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteList = vi.fn();
    const fixture = await render({ getLists: async () => lists, deleteList });
    const open = vi.spyOn(TestBed.inject(MatSnackBar), 'open');
    const element = fixture.nativeElement as HTMLElement;

    const remove = deleteButton(element, 'pid-a');
    expectUnavailable(fixture, remove, 'Cannot delete: entries in use');
    // disabledInteractive keeps the button clickable while it looks disabled.
    remove.click();
    await new Promise((resolve) => setTimeout(resolve));

    expect(confirm).not.toHaveBeenCalled();
    expect(deleteList).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      'Cannot delete a status list that has entries in use',
      'Close',
      expect.anything()
    );
  });

  it('says why each Delete waits or refuses, else what it does', async () => {
    const fixture = await render({ getLists: async () => lists });
    const component = fixture.componentInstance;
    const [unused, inUse] = lists;

    expect(component.listDeleteTooltip(inUse)).toBe('Cannot delete: entries in use');
    expect(component.listDeleteTooltip(unused)).toBe('Delete status list');

    component.deletingId = 'shared-b';
    expect(component.listDeleteTooltip(unused)).toBe('Deleting the status list…');
    expect(component.listDeleteTooltip(statusList('other'))).toBe(
      'Wait until the other delete has finished'
    );
  });

  it('finds a list by its JWT status', async () => {
    const fixture = await render({
      getLists: async () => [
        statusList('old', { expiresAt: '2000-01-01T00:00:00Z' }),
        statusList('fresh', { expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
      ],
    });
    const element = fixture.nativeElement as HTMLElement;

    fixture.componentInstance.search = 'expired';
    fixture.detectChanges();

    expect(ids(element)).toEqual(['old']);
  });
});
