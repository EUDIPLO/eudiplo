import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { vi } from 'vitest';

import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import { SessionManagementService } from '../session-management.service';
import { SessionManagementListComponent } from './session-management-list.component';

describe('SessionManagementListComponent', () => {
  let component: SessionManagementListComponent;
  let fixture: ComponentFixture<SessionManagementListComponent>;
  let getAllSessions: ReturnType<typeof vi.fn>;

  async function setup(queryParams: Record<string, string | string[]> = {}) {
    vi.useFakeTimers();
    getAllSessions = vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      totalPages: 0,
    });
    await TestBed.configureTestingModule({
      imports: [SessionManagementListComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap(queryParams), queryParams },
          },
        },
        {
          provide: SessionManagementService,
          useValue: { getAllSessions, getStatusDisplay: (status: string) => status },
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
});
