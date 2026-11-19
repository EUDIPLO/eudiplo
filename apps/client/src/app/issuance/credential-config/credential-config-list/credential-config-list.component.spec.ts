import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { CredentialConfig } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigOwnershipService } from '../../../config-portability/config-ownership.service';
import { describeListStates } from '../../../common/base-async-list.testing';
import { CredentialConfigService } from '../credential-config.service';
import { JwtService } from '../../../services/jwt.service';

import { CredentialConfigListComponent } from './credential-config-list.component';

describe('CredentialConfigListComponent', () => {
  describeListStates({
    component: CredentialConfigListComponent,
    service: CredentialConfigService,
    fetchMethod: 'loadConfigurations',
    item: { id: 'pid', config: { format: 'dc+sd-jwt', display: [] } },
    loading: 'Loading credential configs',
    empty: 'No credential configs yet.',
    create: 'Create credential config',
    failure: 'Failed to load credential configs',
    heading: 'h1',
    firstCell: 'pid',
  });
});

describe('CredentialConfigListComponent description', () => {
  it('falls back to the configuration description when the display has none', () => {
    TestBed.configureTestingModule({
      imports: [CredentialConfigListComponent],
      providers: [
        provideRouter([]),
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => [] } },
        { provide: JwtService, useValue: { hasRole: () => true } },
      ],
    });
    const component = TestBed.createComponent(CredentialConfigListComponent).componentInstance;
    const config = (display: object[], description?: string) =>
      ({ id: 'pid', description, config: { format: 'dc+sd-jwt', display } }) as CredentialConfig;

    expect(component.getDescription(config([{ name: 'PID', description: 'Wallet' }], 'Own'))).toBe(
      'Wallet'
    );
    expect(component.getDescription(config([{ name: 'PID' }], 'Own'))).toBe('Own');
    expect(component.getDescription(config([{ name: 'PID' }]))).toBe('No description available');
    expect(component.getDescription({ id: 'x', config: {} } as CredentialConfig)).toBe(
      'No description available'
    );
  });

  it('names the credential format', () => {
    TestBed.configureTestingModule({
      imports: [CredentialConfigListComponent],
      providers: [
        provideRouter([]),
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => [] } },
        { provide: JwtService, useValue: { hasRole: () => true } },
      ],
    });
    const component = TestBed.createComponent(CredentialConfigListComponent).componentInstance;
    const config = (format: string) => ({ id: 'x', config: { format } }) as CredentialConfig;

    expect(component.getFormat(config('mso_mdoc'))).toBe('mDOC');
    expect(component.getFormat(config('dc+sd-jwt'))).toBe('SD-JWT VC');
    expect(component.getFormat({ id: 'x', config: {} } as CredentialConfig)).toBe('SD-JWT VC');
  });
});

describe('CredentialConfigListComponent table', () => {
  const configs = [
    {
      id: 'pid',
      lifeTime: 86400,
      statusManagement: true,
      config: { format: 'dc+sd-jwt', display: [{ name: 'PID', description: 'Identity' }] },
    },
    { id: 'mdl', keyBinding: true, config: { format: 'mso_mdoc', display: [] } },
  ] as unknown as CredentialConfig[];

  async function render(service: Partial<CredentialConfigService>, roles = ['issuance:manage']) {
    TestBed.configureTestingModule({
      imports: [CredentialConfigListComponent],
      providers: [
        provideRouter([]),
        { provide: CredentialConfigService, useValue: service },
        { provide: JwtService, useValue: { hasRole: (role: string) => roles.includes(role) } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    });
    const fixture = TestBed.createComponent(CredentialConfigListComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.loading).toBe(false));
    fixture.detectChanges();
    return fixture;
  }

  const ids = (element: HTMLElement) =>
    [...element.querySelectorAll('.item-link')].map((link) => link.textContent?.trim());

  afterEach(() => vi.restoreAllMocks());

  it('sorts by ID, links each ID to its configuration and narrows the rows to the search', async () => {
    const fixture = await render({ loadConfigurations: async () => configs });
    const element = fixture.nativeElement as HTMLElement;

    expect(ids(element)).toEqual(['mdl', 'pid']);
    expect(element.querySelector('.item-link')?.getAttribute('href')).toBe('/mdl');
    expect(element.querySelector('output')?.textContent?.trim()).toBe('2 credential configs');
    const pidRow = element.querySelectorAll('tr.mat-mdc-row')[1] as HTMLElement;
    expect(pidRow.textContent).toContain('SD-JWT VC');
    expect(pidRow.textContent).toContain('1 day');
    expect(pidRow.textContent).toContain('Status managed');

    fixture.componentInstance.search = 'mso_mdoc';
    fixture.detectChanges();
    expect(ids(element)).toEqual(['mdl']);
    expect(element.querySelector('output')?.textContent?.trim()).toBe('1 of 2 credential configs');

    fixture.componentInstance.search = 'identity';
    fixture.detectChanges();
    expect(ids(element)).toEqual(['pid']);

    fixture.componentInstance.search = 'nothing';
    fixture.detectChanges();
    expect(element.querySelector('.no-match')?.textContent).toContain(
      'No credential config matches "nothing".'
    );
  });

  it('deletes a configuration from its row after confirming and takes its row out', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteConfiguration = vi.fn().mockResolvedValue(undefined);
    const loadConfigurations = vi.fn().mockResolvedValue(configs);
    const fixture = await render({ loadConfigurations, deleteConfiguration });
    const element = fixture.nativeElement as HTMLElement;

    element
      .querySelector<HTMLButtonElement>('button[aria-label="Delete credential config pid"]')!
      .click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        [...element.querySelectorAll('.item-link')].map((a) => a.getAttribute('href'))
      ).not.toContain('/pid');
    });
    // The row goes without loading the list again.
    expect(loadConfigurations).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledWith(
      'Delete credential config "pid"? This cannot be undone.'
    );
    expect(deleteConfiguration).toHaveBeenCalledWith('pid');
  });
});
