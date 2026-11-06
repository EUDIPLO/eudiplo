import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import type { Session } from '@eudiplo/sdk-core';
import { of } from 'rxjs';
import { vi } from 'vitest';

import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import { JwtService } from '../../services/jwt.service';
import { SessionManagementService } from '../session-management.service';
import { SessionManagementListComponent } from './session-management-list.component';
import { expectAvailable, expectUnavailable } from '../../common/unavailable-action.testing';

describe('SessionManagementListComponent', () => {
  let component: SessionManagementListComponent;
  let fixture: ComponentFixture<SessionManagementListComponent>;
  let getAllSessions: ReturnType<typeof vi.fn>;
  let cancelSession: ReturnType<typeof vi.fn>;
  let roles: string[];
  let deleteSession: ReturnType<typeof vi.fn>;

  async function setup(
    queryParams: Record<string, string | string[]> = {},
    granted = ['issuance:offer', 'presentation:request']
  ) {
    roles = granted;
    vi.useFakeTimers();
    getAllSessions = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      totalPages: 0,
    });
    cancelSession = vi.fn().mockResolvedValue(undefined);
    deleteSession = vi.fn().mockResolvedValue(undefined);
    await TestBed.configureTestingModule({
      imports: [SessionManagementListComponent],
      providers: [
        provideRouter([]),
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string | string[]) => [role].flat().some((r) => roles.includes(r)),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap(queryParams), queryParams },
          },
        },
        {
          provide: SessionManagementService,
          useValue: {
            getAllSessions,
            cancelSession,
            deleteSession,
            getStatusDisplay: (status: string) => status,
          },
        },
        {
          provide: CredentialConfigService,
          useValue: { loadConfigurations: vi.fn().mockResolvedValue([{ id: 'pid' }]) },
        },
        {
          provide: PresentationManagementService,
          useValue: {
            loadConfigurations: vi
              .fn()
              .mockResolvedValue([{ id: 'age-check', description: 'Age check' }]),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SessionManagementListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the first page without filters', async () => {
    await setup();
    expect(getAllSessions).toHaveBeenCalledWith({ page: 1, pageSize: 25 });
    expect(component.issuanceConfigOptions).toEqual([{ value: 'issuance:pid', label: 'pid' }]);
    expect(component.presentationConfigOptions).toEqual([
      { value: 'presentation:age-check', label: 'age-check (Age check)' },
    ]);
  });

  it('restores filters, sort and page from the URL', async () => {
    await setup({
      q: 'order-4711',
      type: 'presentation',
      status: ['failed', 'unknown'],
      requestId: 'age-check',
      createdFrom: '2026-10-01',
      createdTo: '2026-10-02',
      page: '3',
      pageSize: '50',
      sortBy: 'updatedAt',
      sortOrder: 'asc',
    });
    expect(getAllSessions).toHaveBeenCalledWith({
      page: 3,
      pageSize: 50,
      q: 'order-4711',
      type: 'presentation',
      status: ['failed'],
      requestId: 'age-check',
      createdFrom: new Date(2026, 9, 1).toISOString(),
      createdTo: new Date(2026, 9, 2, 23, 59, 59, 999).toISOString(),
      sortBy: 'updatedAt',
      sortOrder: 'asc',
    });
  });

  it('applies the pending shortcut and keeps the filters in the URL', async () => {
    await setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    component.showPending();
    component.filters.controls.config.setValue('issuance:pid');
    vi.advanceTimersByTime(300);
    await fixture.whenStable();

    expect(component.isPendingSelected()).toBe(true);
    expect(getAllSessions).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 25,
      status: ['active', 'fetched'],
      credentialConfigurationId: 'pid',
    });
    expect(navigate).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({
        replaceUrl: true,
        queryParams: expect.objectContaining({
          status: ['active', 'fetched'],
          credentialConfigurationId: 'pid',
          requestId: null,
        }),
      })
    );
  });

  it('restores a relative update window and the failure code, resolved against now', async () => {
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    await setup({ updatedWithin: '1h', failureCode: 'trust_chain_not_trusted', status: 'failed' });
    expect(component.filters.controls.updated.value).toBe('1h');
    expect(getAllSessions).toHaveBeenCalledWith({
      page: 1,
      pageSize: 25,
      status: ['failed'],
      updatedFrom: '2026-10-02T11:00:00.000Z',
      failureCode: 'trust_chain_not_trusted',
    });
  });

  it('restores a custom update range as whole days', async () => {
    await setup({ updatedFrom: '2026-10-01', updatedTo: '2026-10-02' });
    expect(component.filters.controls.updated.value).toBe('custom');
    expect(getAllSessions).toHaveBeenCalledWith({
      page: 1,
      pageSize: 25,
      updatedFrom: new Date(2026, 9, 1).toISOString(),
      updatedTo: new Date(2026, 9, 2, 23, 59, 59, 999).toISOString(),
    });
  });

  it('keeps the update window and failure code in the URL', async () => {
    await setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    component.filters.patchValue({ updated: '24h', failureCode: ' access_denied ' });
    vi.advanceTimersByTime(300);
    await fixture.whenStable();

    expect(getAllSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ updatedFrom: expect.any(String), failureCode: 'access_denied' })
    );
    expect(navigate).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({
        queryParams: expect.objectContaining({
          updatedWithin: '24h',
          updatedFrom: null,
          updatedTo: null,
          failureCode: 'access_denied',
        }),
      })
    );
    expect(component.hasActiveFilters()).toBe(true);
  });

  it('suggests matching failure codes', async () => {
    await setup();
    component.filters.controls.failureCode.setValue('TRUST');
    expect(component.matchingFailureCodes()).toEqual([
      'no_trust_chain_to_root',
      'trust_chain_not_trusted',
      'trust_list_unavailable',
    ]);
  });

  it('clears all filters', async () => {
    await setup({ q: 'abc', status: 'failed' });
    expect(component.hasActiveFilters()).toBe(true);
    component.clearFilters();
    expect(component.hasActiveFilters()).toBe(false);
  });

  it('cancels only the selected sessions that are still pending, with the given reason', async () => {
    await setup();
    const open = vi
      .spyOn(TestBed.inject(MatDialog), 'open')
      .mockReturnValue({ afterClosed: () => of({ reason: 'sent to wrong recipient' }) } as never);
    const active = { id: 's-1', status: 'active' } as Session;
    const fetched = { id: 's-2', status: 'fetched' } as Session;
    const completed = { id: 's-3', status: 'completed' } as Session;
    const redeemed = { id: 's-4', status: 'active', consumed: true } as Session;
    component.selection.select(active, fetched, completed, redeemed);

    expect(component.cancellableSelected).toEqual([active, fetched]);
    await component.cancelSelectedSessions();

    expect(open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ data: { count: 2 } })
    );
    expect(cancelSession).toHaveBeenCalledTimes(2);
    expect(cancelSession).toHaveBeenCalledWith('s-1', 'sent to wrong recipient');
    expect(cancelSession).toHaveBeenCalledWith('s-2', 'sent to wrong recipient');
    expect(component.selection.selected).toEqual([]);
  });

  function bulkButton(label: string): HTMLButtonElement {
    return [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes(label))!;
  }

  /** Selects a pending session; the cancellation dialog answers with a reason. */
  async function selectPending() {
    await setup();
    const open = vi
      .spyOn(TestBed.inject(MatDialog), 'open')
      .mockReturnValue({ afterClosed: () => of({ reason: 'sent to wrong recipient' }) } as never);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    );
    component.selection.select({ id: 's-1', status: 'active' } as Session);
    fixture.detectChanges();
    return { open, confirm: window.confirm as ReturnType<typeof vi.fn> };
  }

  it('describes the bulk actions while they can be used', async () => {
    await selectPending();

    expectAvailable(
      fixture,
      bulkButton('Cancel Selected'),
      'Cancel the selected offers a wallet has not redeemed yet, so it can no longer use them'
    );
    expectAvailable(fixture, bulkButton('Delete Selected'), 'Delete selected sessions');
  });

  it('keeps both bulk actions focusable while a cancellation runs: a second click sends nothing', async () => {
    const { open, confirm } = await selectPending();
    cancelSession.mockReturnValue(new Promise(() => undefined));
    const cancel = bulkButton('Cancel Selected');
    const remove = bulkButton('Delete Selected');

    cancel.click();
    await vi.waitFor(() => expect(component.cancellingSelected).toBe(true));
    fixture.detectChanges();
    cancel.click();
    remove.click();
    fixture.detectChanges();

    expect(open).toHaveBeenCalledOnce();
    expect(cancelSession).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
    expectUnavailable(fixture, cancel, 'Cancelling the selected sessions…');
    expectUnavailable(fixture, remove, 'Cancelling the selected sessions…');
  });

  it('keeps both bulk actions focusable while a delete runs: a second click sends nothing', async () => {
    const { open, confirm } = await selectPending();
    deleteSession.mockReturnValue(new Promise(() => undefined));
    const cancel = bulkButton('Cancel Selected');
    const remove = bulkButton('Delete Selected');

    remove.click();
    fixture.detectChanges();
    remove.click();
    cancel.click();
    fixture.detectChanges();

    expect(confirm).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expectUnavailable(fixture, remove, 'Deleting the selected sessions…');
    expectUnavailable(fixture, cancel, 'Deleting the selected sessions…');
  });

  it('says why Cancel Selected is unavailable when no selected session can be cancelled', async () => {
    await setup();
    const open = vi.spyOn(TestBed.inject(MatDialog), 'open');
    component.selection.select(
      { id: 's-3', status: 'completed' } as Session,
      { id: 's-4', status: 'active', consumed: true } as Session
    );
    fixture.detectChanges();
    const cancel = bulkButton('Cancel Selected');

    expectUnavailable(
      fixture,
      cancel,
      'None of the selected sessions can be cancelled: a wallet has redeemed them or they have ended'
    );
    cancel.click();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['a cancellation', 'Cancel Selected', () => component.cancelSelectedSessions()],
    ['a delete', 'Delete Selected', () => component.deleteSelectedSessions()],
    ['Clear', 'Clear', async () => component.clearSelection()],
  ])(
    'moves the focus to the heading when the bulk actions go away after %s',
    async (_, label, act) => {
      await selectPending();
      bulkButton(label).focus();

      await act();
      fixture.detectChanges();

      expect(bulkButton('Cancel Selected')).toBeUndefined();
      await vi.waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Sessions'));
    }
  );

  it('reports sessions that were no longer pending apart from other errors', async () => {
    await setup();
    vi.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({
      afterClosed: () => of({}),
    } as never);
    const snackBar = vi.spyOn(TestBed.inject(MatSnackBar), 'open');
    cancelSession
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ statusCode: 409, message: 'already redeemed' })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    component.selection.select(
      { id: 's-1', status: 'active' } as Session,
      { id: 's-2', status: 'active' } as Session,
      { id: 's-3', status: 'fetched' } as Session
    );

    await component.cancelSelectedSessions();

    expect(snackBar).toHaveBeenCalledWith(
      'Cancelled 1 of 3 sessions; 1 no longer pending; ' +
        '1 failed: the backend could not be reached. Check the connection and try again.',
      'Close',
      expect.anything()
    );
  });

  it('offers sessions:read no selection to cancel or delete', async () => {
    await setup({}, ['sessions:read']);

    expect(component.displayedColumns).not.toContain('select');
    expect(component.canChange({ id: 's-1' } as Session)).toBe(false);
    const buttons = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].map(
      (button) => button.textContent!.trim()
    );
    expect(buttons.some((text) => text.includes('Issuance Offer'))).toBe(false);
    expect(buttons.some((text) => text.includes('Presentation Request'))).toBe(false);
  });

  it('counts the manage roles toward a side, like the backend', async () => {
    await setup({}, ['presentation:request', 'issuance:manage']);

    expect(component.canChange({ id: 's-1', status: 'active' } as Session)).toBe(true);
    expect(
      component.canChange({ id: 's-2', status: 'active', requestId: 'age-check' } as Session)
    ).toBe(true);
  });

  it('offers no select-all on a page without sessions the caller may change', async () => {
    await setup({}, ['issuance:offer', 'sessions:read']);
    component.dataSource.data = [
      { id: 's-2', status: 'active', requestId: 'age-check' } as Session,
    ];

    expect(component.hasChangeableRows).toBe(false);
    expect(component.isAllSelected()).toBe(false);
  });

  it('selects only the sessions of the side the caller may change', async () => {
    await setup({}, ['issuance:offer', 'sessions:read']);
    const issuance = { id: 's-1', status: 'active' } as Session;
    const presentation = { id: 's-2', status: 'active', requestId: 'age-check' } as Session;
    component.dataSource.data = [issuance, presentation];

    expect(component.displayedColumns).toContain('select');
    component.masterToggle();

    expect(component.selection.selected).toEqual([issuance]);
    expect(component.isAllSelected()).toBe(true);
    expect(component.checkboxLabel(presentation)).toBe(
      'row s-2: Your roles let you read this session but not cancel or delete it'
    );
  });

  it('does not cancel anything when the dialog is dismissed', async () => {
    await setup();
    vi.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({
      afterClosed: () => of(undefined),
    } as never);
    component.selection.select({ id: 's-1', status: 'active' } as Session);

    await component.cancelSelectedSessions();

    expect(cancelSession).not.toHaveBeenCalled();
  });

  it('shows why loading failed and a retry instead of "No sessions found"', async () => {
    await setup();
    component.selection.select({ id: 's-1', status: 'active' } as Session);
    getAllSessions.mockRejectedValueOnce({ statusCode: 403, message: 'Forbidden resource' });

    component.refreshSessions();
    await fixture.whenStable();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Failed to load sessions: Forbidden resource'
    );
    expect(element.textContent).not.toContain('No sessions found');
    // Bulk actions must not act on sessions that are no longer shown.
    expect(component.selection.selected).toEqual([]);
  });

  it('deletes selected sessions only after confirmation and reports the ones that failed', async () => {
    await setup();
    const confirm = vi.fn<(message?: string) => boolean>(() => false);
    vi.stubGlobal('confirm', confirm);
    const snackBar = vi.spyOn(TestBed.inject(MatSnackBar), 'open');
    deleteSession
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ statusCode: 403, message: 'Forbidden resource' });
    component.selection.select(
      { id: 's-1', status: 'completed' } as Session,
      { id: 's-2', status: 'completed' } as Session
    );

    await component.deleteSelectedSessions();
    expect(confirm.mock.calls[0][0]).toContain('Delete 2 sessions?');
    expect(deleteSession).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await component.deleteSelectedSessions();

    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(snackBar).toHaveBeenCalledWith(
      'Deleted 1 of 2 sessions; 1 failed: Forbidden resource',
      'Close',
      expect.anything()
    );
    expect(component.selection.selected).toEqual([]);
  });

  it('reports when every selected session was deleted', async () => {
    await setup();
    vi.stubGlobal('confirm', () => true);
    const snackBar = vi.spyOn(TestBed.inject(MatSnackBar), 'open');
    component.selection.select(
      { id: 's-1', status: 'completed' } as Session,
      { id: 's-2', status: 'completed' } as Session
    );

    await component.deleteSelectedSessions();

    expect(snackBar).toHaveBeenCalledWith('Deleted 2 sessions', 'Close', expect.anything());
  });
});
