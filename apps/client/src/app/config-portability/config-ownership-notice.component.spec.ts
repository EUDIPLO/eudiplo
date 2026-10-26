import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';

import { JwtService } from '../services/jwt.service';
import { ConfigOwnershipNoticeComponent } from './config-ownership-notice.component';
import {
  ConfigOwnershipService,
  ConfigResourceKind,
  ConfigResourceOwnership,
} from './config-ownership.service';

describe('ConfigOwnershipNoticeComponent', () => {
  async function render(
    lookup: () => Promise<ConfigResourceOwnership | undefined>,
    roles: string[] = ['presentation:manage'],
    kind: ConfigResourceKind = 'PresentationConfig'
  ): Promise<HTMLElement> {
    TestBed.configureTestingModule({
      imports: [ConfigOwnershipNoticeComponent],
      providers: [
        provideRouter([]),
        { provide: ConfigOwnershipService, useValue: { get: vi.fn(lookup) } },
        {
          provide: JwtService,
          useValue: {
            hasTenantContext: () => true,
            hasRole: (role: string | string[]) => [role].flat().some((r) => roles.includes(r)),
            canUseConfigPortability: JwtService.prototype.canUseConfigPortability,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ConfigOwnershipNoticeComponent);
    fixture.componentRef.setInput('kind', kind);
    fixture.componentRef.setInput('resourceId', 'pid');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const resource = (
    ownership: ConfigResourceOwnership['ownership'],
    source = 'folder:/config/demo'
  ): ConfigResourceOwnership => ({
    kind: 'PresentationConfig',
    resourceId: 'pid',
    ownership,
    generation: 2,
    source,
  });
  const link = (element: HTMLElement) => element.querySelector('a')?.getAttribute('href') ?? null;

  it('tells a client without tenant:admin whom to ask, without a link it cannot open', async () => {
    const element = await render(async () => resource('file-managed'));

    expect(element.textContent).toContain('Managed by a configuration bundle');
    expect(element.textContent).toContain('ask someone with the tenant:admin role');
    expect(element.textContent).toContain('folder:/config/demo');
    expect(link(element)).toBeNull();
  });

  it('links a tenant admin to Config Portability', async () => {
    const element = await render(async () => resource('file-managed'), ['tenant:admin']);

    expect(element.textContent).toContain('Edit folder:/config/demo and apply it again');
    expect(link(element)).toBe('/settings/config-portability');
  });

  it('tells a tenant admin to reset a detached resource', async () => {
    const element = await render(async () => resource('detached'), ['tenant:admin']);

    expect(element.textContent).toContain('Detached from folder:/config/demo');
    expect(element.textContent).toContain('Reset it to the file version');
    expect(link(element)).toBe('/settings/config-portability');
  });

  it('tells other clients who can reset a detached resource', async () => {
    const element = await render(async () => resource('detached'));

    expect(element.textContent).toContain('Someone with the tenant:admin role can reset it');
    expect(link(element)).toBeNull();
  });

  it('tells a tenant admin that a reset applies all tenant settings', async () => {
    const tenant = await render(async () => resource('detached'), ['tenant:admin'], 'Tenant');
    expect(tenant.textContent).toContain('Reset it to the file version');
    expect(tenant.textContent).toContain('applies all tenant settings of info.json');
  });

  it('tells other clients who can reset detached tenant settings', async () => {
    const tenant = await render(
      async () => resource('detached'),
      ['presentation:manage'],
      'Tenant'
    );
    expect(tenant.textContent).toContain('Someone with the tenant:admin role can reset it');
  });

  it('offers no reset where Config Portability has none', async () => {
    const bundle = await render(async () => resource('detached', 'bundle:acme'), ['tenant:admin']);
    expect(bundle.textContent).toContain('Imports from this source skip this resource.');
    expect(bundle.textContent).not.toContain('Reset');
  });

  it('shows nothing for an unmanaged resource or a failed lookup', async () => {
    expect((await render(async () => resource('unmanaged'))).textContent?.trim()).toBe('');
    TestBed.resetTestingModule();
    const failed = await render(() => Promise.reject({ statusCode: 403 }));
    expect(failed.textContent?.trim()).toBe('');
  });
  it('points a client from the config folder to Apply from file for a new secret', async () => {
    const folder = await render(async () => resource('file-managed'), ['tenant:admin'], 'Client');
    TestBed.resetTestingModule();
    const bundle = await render(
      async () => resource('file-managed', 'bundle:demo'),
      ['tenant:admin'],
      'Client'
    );
    TestBed.resetTestingModule();
    const other = await render(async () => resource('file-managed'), ['tenant:admin']);

    expect(folder.textContent).toContain(
      'choose Apply from file under Config Portability to get a new secret'
    );
    expect(bundle.textContent).not.toContain('Apply from file');
    expect(other.textContent).not.toContain('Apply from file');
  });
});
