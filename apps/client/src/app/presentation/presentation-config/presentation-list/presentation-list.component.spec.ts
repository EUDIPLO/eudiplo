import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import type { PresentationConfig } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';
import { JwtService } from '../../../services/jwt.service';
import { PresentationManagementService } from '../presentation-management.service';
import { PresentationListComponent } from './presentation-list.component';
import { describeListStates } from '../../../common/base-async-list.testing';

const configs = [
  { id: 'pid', description: 'PID check', createdAt: '2026-11-01T00:00:00Z' },
  {
    id: 'age-over-18',
    description: 'Age verification',
    createdAt: '2026-11-02T00:00:00Z',
    registration_cert: { purpose: [{ lang: 'en', content: 'Age' }] },
  },
] as unknown as PresentationConfig[];

async function render(
  service: Partial<PresentationManagementService>,
  roles: string[] = ['presentation:manage']
) {
  const snackBar = { open: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [PresentationListComponent],
    providers: [
      provideRouter([]),
      { provide: PresentationManagementService, useValue: service },
      { provide: MatSnackBar, useValue: snackBar },
      { provide: JwtService, useValue: { hasRole: (role: string) => roles.includes(role) } },
      { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(PresentationListComponent);
  fixture.detectChanges();
  const page = fixture.nativeElement as HTMLElement;
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(fixture.componentInstance.loading).toBe(false);
  });
  return { fixture, page, component: fixture.componentInstance, snackBar };
}

describe('PresentationListComponent', () => {
  describeListStates({
    component: PresentationListComponent,
    service: PresentationManagementService,
    fetchMethod: 'loadConfigurations',
    item: { id: 'pid', description: 'PID check' },
    loading: 'Loading verification configs',
    empty: 'No verification configs yet',
    create: 'Create config',
    heading: 'h1',
    failure: 'Failed to load verification configs',
    providers: [
      { provide: JwtService, useValue: { hasRole: () => true } },
      { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
    ],
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('lists the configs by ID, each linked to its page, with the certificate state', async () => {
    const { page } = await render({ loadConfigurations: async () => configs });
    const rows = [...page.querySelectorAll('tr.mat-mdc-row')];

    expect(rows.map((row) => row.querySelector('a.item-link')?.textContent?.trim())).toEqual([
      'age-over-18',
      'pid',
    ]);
    expect(rows[1].querySelector('a.item-link')?.getAttribute('href')).toBe('/pid');
    expect(rows[0].querySelector('.badge')?.textContent?.trim()).toBe('No certificate');
    expect(rows[1].querySelector('.badge')).toBeNull();
    expect(page.querySelector('.table-title output')?.textContent?.trim()).toBe('2 configs');
  });

  it('finds configs by description and says when none matches', async () => {
    const { fixture, page } = await render({ loadConfigurations: async () => configs });
    const field = page.querySelector<HTMLInputElement>('input[type="search"]')!;
    const type = (value: string) => {
      field.value = value;
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const shown = () =>
      [...page.querySelectorAll('a.item-link')].map((link) => link.textContent?.trim());

    type('AGE ver');
    expect(shown()).toEqual(['age-over-18']);
    expect(page.querySelector('.table-title output')?.textContent?.trim()).toBe('1 of 2 configs');

    type('nothing');
    expect(page.querySelector('.no-match')?.textContent).toContain('No config matches "nothing".');
    page.querySelector<HTMLButtonElement>('.no-match button')!.click();
    fixture.detectChanges();
    expect(shown()).toEqual(['age-over-18', 'pid']);
  });

  it('deletes a config once after confirmation and removes its row', async () => {
    let finish!: () => void;
    const deleteConfiguration = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { component, fixture, page, snackBar } = await render({
      loadConfigurations: async () => configs,
      deleteConfiguration: deleteConfiguration as never,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const deleting = component.deleteConfiguration(configs[0]);
    fixture.detectChanges();
    const button = page.querySelectorAll<HTMLButtonElement>('button.delete-action')[1];
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // A second click while the first runs does nothing.
    await component.deleteConfiguration(configs[0]);
    expect(deleteConfiguration).toHaveBeenCalledTimes(1);

    finish();
    await deleting;
    fixture.detectChanges();
    expect(deleteConfiguration).toHaveBeenCalledWith('pid');
    expect(snackBar.open).toHaveBeenCalledWith('Verification config deleted', 'Close', {
      duration: 3000,
    });
    expect([...page.querySelectorAll('a.item-link')].map((a) => a.textContent?.trim())).toEqual([
      'age-over-18',
    ]);
  });

  it('keeps the config and says why when the delete fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fixture, page, component, snackBar } = await render({
      loadConfigurations: async () => configs,
      deleteConfiguration: vi.fn().mockRejectedValue({ statusCode: 500, message: 'x' }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await component.deleteConfiguration(configs[0]);
    fixture.detectChanges();

    expect(snackBar.open.mock.calls.at(-1)?.[0]).toBe('Failed to delete verification config: x');
    expect([...page.querySelectorAll('a.item-link')].map((a) => a.textContent?.trim())).toEqual([
      'age-over-18',
      'pid',
    ]);
    expect(page.querySelectorAll('button.delete-action')[1].getAttribute('aria-disabled')).not.toBe(
      'true'
    );
  });

  it('deletes nothing without confirmation', async () => {
    const deleteConfiguration = vi.fn(async () => undefined);
    const { component } = await render({
      loadConfigurations: async () => configs,
      deleteConfiguration: deleteConfiguration as never,
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await component.deleteConfiguration(configs[0]);

    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteConfiguration).not.toHaveBeenCalled();
  });
});
