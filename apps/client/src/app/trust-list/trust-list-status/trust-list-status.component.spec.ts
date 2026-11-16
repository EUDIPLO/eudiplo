import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import type { TrustListStatusResponseDto } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TrustListService } from '../trust-list.service';
import { TrustListStatusComponent } from './trust-list-status.component';

describe('TrustListStatusComponent', () => {
  const status = (overrides: Partial<TrustListStatusResponseDto> = {}) =>
    ({
      url: 'https://lists.example/pid',
      trustListId: null,
      outcome: 'accepted',
      reason: null,
      checkedAt: '2026-11-16T10:00:00Z',
      verifiedAt: '2026-11-16T10:00:00Z',
      acceptedAt: '2026-11-16T10:00:00Z',
      nextUpdate: '2099-01-01T00:00:00Z',
      sequenceNumber: 3,
      entities: 2,
      ...overrides,
    }) as TrustListStatusResponseDto;

  async function render(
    getStatus: () => Promise<TrustListStatusResponseDto[]>,
    fragment: string | null = null
  ) {
    TestBed.configureTestingModule({
      imports: [TrustListStatusComponent],
      providers: [
        provideRouter([]),
        { provide: TrustListService, useValue: { getStatus } },
        { provide: ActivatedRoute, useValue: { snapshot: { fragment } } },
      ],
    });
    const fixture = TestBed.createComponent(TrustListStatusComponent);
    const loadItems = vi.spyOn(fixture.componentInstance, 'loadItems');
    fixture.detectChanges();
    await loadItems.mock.results[0].value;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows each list with its outcome, reason and a link to a managed list', async () => {
    const element = await render(async () => [
      status({
        url: 'https://eudiplo.example/issuers/t/trust-list/own',
        trustListId: 'own',
        outcome: 'failed',
        reason: 'The list URL answered with HTTP status 404',
        acceptedAt: null,
        nextUpdate: '2020-01-01T00:00:00Z',
      }),
      status(),
    ]);
    const rows = element.querySelectorAll('tr[mat-row]');

    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Failed');
    expect(rows[0].textContent).toContain('The list URL answered with HTTP status 404');
    expect(rows[0].textContent).toContain('Never accepted');
    expect(rows[0].textContent).toContain('Passed; fetched again on next use');
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/trust-list/own');
    expect(rows[1].textContent).toContain('Accepted');
    expect(rows[1].textContent).toContain('https://lists.example/pid');
    expect(rows[1].textContent).not.toContain('Never accepted');
  });

  it('says when no list has been loaded yet', async () => {
    const element = await render(async () => []);
    expect(element.textContent).toContain('No trust list has been loaded yet.');
  });

  it('shows a load error with a retry instead of an empty list', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const element = await render(async () => {
      throw new Error('Database unavailable');
    });
    expect(element.querySelector('app-load-error')).not.toBeNull();
    expect(element.textContent).not.toContain('No trust list has been loaded yet.');
  });

  it('describes closed, unverified and stale lists', async () => {
    const element = await render(async () => [
      status({ nextUpdate: null }),
      status({ outcome: 'failed', verifiedAt: null, nextUpdate: null }),
      status({ checkedAt: '2020-01-01T00:00:00Z' }),
    ]);
    const rows = element.querySelectorAll('tr[mat-row]');
    expect(rows[0].textContent).toContain('None (closed list)');
    expect(rows[1].textContent).toContain('Not verified yet');
    expect(rows[2].textContent).toContain('Not loaded for 7 days');
    expect(rows[0].textContent).not.toContain('Not loaded for');
  });

  it('shows a labelled spinner while loading and loads again from the reload button', async () => {
    let resolve!: (value: TrustListStatusResponseDto[]) => void;
    const getStatus = vi
      .fn<() => Promise<TrustListStatusResponseDto[]>>()
      .mockReturnValueOnce(new Promise((done) => (resolve = done)))
      .mockResolvedValue([status()]);
    TestBed.configureTestingModule({
      imports: [TrustListStatusComponent],
      providers: [provideRouter([]), { provide: TrustListService, useValue: { getStatus } }],
    });
    const fixture = TestBed.createComponent(TrustListStatusComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(
      element.querySelector('[aria-label="Loading the status of the trust lists in use"]')
    ).not.toBeNull();

    resolve([]);
    await fixture.whenStable();
    fixture.detectChanges();
    (
      element.querySelector(
        '[aria-label="Reload the status of the trust lists in use"]'
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(element.querySelectorAll('tr[mat-row]')).toHaveLength(1);
  });

  it('focuses its heading when the link names the section', async () => {
    const element = await render(async () => [status()], 'trust-list-status-heading');
    TestBed.inject(ApplicationRef).tick();
    expect(document.activeElement).toBe(element.querySelector('#trust-list-status-heading'));
  });

  it('leaves focus on Reload when the section reloads under the same link', async () => {
    const element = await render(async () => [], 'trust-list-status-heading');
    TestBed.inject(ApplicationRef).tick();
    const reload = element.querySelector(
      '[aria-label="Reload the status of the trust lists in use"]'
    ) as HTMLButtonElement;
    reload.focus();
    reload.click();
    await new Promise((done) => setTimeout(done, 0));
    expect(document.activeElement).toBe(reload);
  });
});
