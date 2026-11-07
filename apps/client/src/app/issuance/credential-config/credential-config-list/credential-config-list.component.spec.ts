import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import type { CredentialConfig } from '@eudiplo/sdk-core';
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
    loading: 'Loading credential configurations',
    empty: 'No credential configurations yet.',
    create: 'Create Credential Configuration',
    createButton: 'Create New Credential Configuration',
    failure: 'Failed to load credential configurations',
  });
});

describe('CredentialConfigListComponent schema badge', () => {
  async function render(roles: string[]): Promise<HTMLElement> {
    const configs = [
      {
        id: 'pid',
        config: { format: 'dc+sd-jwt', display: [{ description: 'PID' }] },
        schemaMeta: { id: 'https://registrar.example/schema-metadata/schema-1' },
      },
    ] as unknown as CredentialConfig[];
    TestBed.configureTestingModule({
      imports: [CredentialConfigListComponent],
      providers: [
        provideRouter([]),
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => configs } },
        { provide: JwtService, useValue: { hasRole: (role: string) => roles.includes(role) } },
      ],
    });
    const fixture = TestBed.createComponent(CredentialConfigListComponent);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[aria-label="Schema created"]')).not.toBeNull();
    });
    return fixture.nativeElement as HTMLElement;
  }

  it('links the schema for users who can open it', async () => {
    const badge = (await render(['issuance:manage', 'registrar:manage'])).querySelector(
      '[aria-label="Schema created"]'
    );

    expect(badge?.tagName).toBe('A');
    expect(badge?.getAttribute('href')).toMatch(/^\/schema\//);
  });

  it('shows the badge without a link when the schema pages would deny access', async () => {
    const badge = (await render(['issuance:manage'])).querySelector(
      '[aria-label="Schema created"]'
    );

    expect(badge?.tagName).toBe('SPAN');
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
  });
});
