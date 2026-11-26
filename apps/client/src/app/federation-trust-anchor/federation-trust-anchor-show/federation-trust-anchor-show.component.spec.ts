import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { IssuanceConfigService } from '../../issuance/issuance-config/issuance-config.service';
import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import { JwtService, type Role } from '../../services/jwt.service';
import { FederationTrustAnchorService } from '../federation-trust-anchor.service';
import { FederationTrustAnchorShowComponent } from './federation-trust-anchor-show.component';
import { grantEveryRole } from '../../common/role-lock.testing';
import { effectiveRoles } from '../../services/role-grants';

// The tests are about what the actions do; role locks have their own tests.
beforeEach(() => grantEveryRole());

const anchor = {
  id: 'eu-federation',
  tenantId: 'tenant',
  entityId: 'https://ta.example',
  description: 'EU federation',
  jwks: { keys: [{ kty: 'EC', kid: 'ta-2026', crv: 'P-256', x: 'x', y: 'y' }] },
};

describe('FederationTrustAnchorShowComponent', () => {
  function render(
    options: {
      roles?: Role[];
      service?: Record<string, unknown>;
      presentations?: () => Promise<unknown[]>;
    } = {}
  ) {
    const roles = options.roles ?? ['issuance:manage', 'presentation:manage'];
    const service = options.service ?? {
      getById: vi.fn().mockResolvedValue(anchor),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      imports: [FederationTrustAnchorShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'eu-federation' }) } },
        },
        { provide: FederationTrustAnchorService, useValue: service },
        {
          provide: IssuanceConfigService,
          useValue: {
            getConfig: async () => ({
              federation: {
                trustAnchors: [{ entityId: 'https://ta.example', entityConfigurationUri: 'x' }],
              },
            }),
          },
        },
        {
          provide: PresentationManagementService,
          useValue: {
            loadConfigurations:
              options.presentations ??
              (async () => [
                {
                  id: 'pid',
                  dcql_query: {
                    credentials: [
                      {
                        trusted_authorities: [
                          { type: 'openid_federation', values: ['https://ta.example'] },
                        ],
                      },
                    ],
                  },
                },
                { id: 'other', dcql_query: { credentials: [] } },
              ]),
          },
        },
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: Role | Role[]) =>
              (Array.isArray(role) ? role : [role]).some((r) => effectiveRoles(roles).includes(r)),
            canUseConfigPortability: () => false,
          },
        },
        { provide: ConfigDocumentService, useValue: { isDownloading: () => false } },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    });
    const fixture = TestBed.createComponent(FederationTrustAnchorShowComponent);
    fixture.detectChanges();
    return { fixture, component: fixture.componentInstance, service };
  }

  async function loaded(fixture: ReturnType<typeof render>['fixture']): Promise<HTMLElement> {
    const component = fixture.componentInstance;
    await vi.waitFor(() => expect(!!component.anchor && !component.references.loading).toBe(true));
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leads back to the list while the trust anchor is still loading', () => {
    const { fixture } = render({
      service: { getById: () => new Promise(() => undefined), delete: vi.fn() },
    });
    const back = (fixture.nativeElement as HTMLElement).querySelector('a.back-link');

    expect(back?.textContent?.trim()).toContain('Federation Trust Anchors');
    expect(fixture.nativeElement.querySelector('output')?.textContent).toContain('Loading');
  });

  it('lists the pinned keys and the configurations naming the entity ID', async () => {
    const { fixture } = render();
    const element = await loaded(fixture);

    expect(element.textContent).toContain('https://ta.example');
    const keyRow = [...element.querySelectorAll('tr[mat-row] td')].map((td) =>
      td.textContent?.trim()
    );
    expect(keyRow).toEqual(['ta-2026', 'EC', 'P-256', '—', '—']);
    expect(element.querySelector('[aria-label="Open issuance configuration"]')).not.toBeNull();
    expect(element.querySelector('[aria-label="Open verification config pid"]')).not.toBeNull();
    expect(element.querySelector('[aria-label="Open verification config other"]')).toBeNull();
  });

  it('refuses up front to delete a trust anchor that known configurations name', async () => {
    const { fixture, service } = render();
    await loaded(fixture);
    const confirm = vi.spyOn(window, 'confirm');
    const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');

    await fixture.componentInstance.delete();

    expect(open.mock.calls[0][0]).toBe(
      'Trust anchor "EU federation" (eu-federation) is still named by the issuance configuration' +
        ' and 1 verification config. Remove these references before deleting it.'
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(service['delete']).not.toHaveBeenCalled();
  });

  it('deletes a trust anchor no visible configuration names and returns to the list', async () => {
    const { fixture, service } = render({
      roles: ['presentation:manage'],
      presentations: async () => [],
    });
    await loaded(fixture);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await fixture.componentInstance.delete();

    expect(service['delete']).toHaveBeenCalledWith('eu-federation');
    expect(navigate).toHaveBeenCalledWith(['/federation-trust-anchor']);
  });

  it('reloads the references when the backend refuses the delete for references', async () => {
    const service = {
      getById: vi.fn().mockResolvedValue(anchor),
      delete: vi.fn().mockRejectedValue({ statusCode: 409, message: 'still named by' }),
    };
    const { fixture } = render({
      service,
      roles: ['presentation:manage'],
      presentations: async () => [],
    });
    await loaded(fixture);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const load = vi.spyOn(fixture.componentInstance.references, 'load');

    await fixture.componentInstance.delete();

    expect(load).toHaveBeenCalledWith('https://ta.example');
  });

  it('asks with the generic consequence when no configuration names the anchor', async () => {
    const { fixture } = render({ roles: ['presentation:manage'], presentations: async () => [] });
    await loaded(fixture);

    expect(fixture.componentInstance.deleteQuestion()).toBe(
      'Delete trust anchor "EU federation" (eu-federation)? If a configuration names its entity ID,' +
        ' the delete is refused and the configurations are named. This cannot be undone.'
    );
  });

  it('waits for the references before asking to delete', async () => {
    let resolve!: (configs: unknown[]) => void;
    const { fixture } = render({
      presentations: () => new Promise((done) => (resolve = done)),
    });
    await vi.waitFor(() => expect(fixture.componentInstance.references.loading).toBe(true));
    fixture.detectChanges();
    const confirm = vi.spyOn(window, 'confirm');

    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[aria-label="Delete trust anchor"]'
    )!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await fixture.componentInstance.delete();
    expect(confirm).not.toHaveBeenCalled();
    resolve([]);
  });

  it('reports a refused delete and allows another attempt', async () => {
    const service = {
      getById: vi.fn().mockResolvedValue(anchor),
      delete: vi.fn().mockRejectedValue({ statusCode: 500, message: 'Database unavailable' }),
    };
    const { fixture } = render({
      service,
      roles: ['presentation:manage'],
      presentations: async () => [],
    });
    await loaded(fixture);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const open = vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');

    await fixture.componentInstance.delete();

    expect(open.mock.calls[0][0]).toContain('Database unavailable');
    expect(fixture.componentInstance.deleting).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('still shows the trust anchor when its references cannot be loaded', async () => {
    const { fixture } = render({
      presentations: async () => {
        throw new Error('Database unavailable');
      },
    });
    const element = await loaded(fixture);

    expect(element.textContent).toContain('Could not load the verification configs.');
    expect(element.textContent).toContain('https://ta.example');
  });

  it('does not delete when the question is declined', async () => {
    const { fixture, service } = render({
      roles: ['presentation:manage'],
      presentations: async () => [],
    });
    await loaded(fixture);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    await fixture.componentInstance.delete();

    expect(service['delete']).not.toHaveBeenCalled();
  });

  it('says which role shows the references it cannot read', async () => {
    const { fixture } = render({ roles: ['presentation:manage'] });
    const element = await loaded(fixture);

    expect(element.textContent).toContain('You need the issuance:read role');
    expect(element.querySelector('[aria-label="Open verification config pid"]')).not.toBeNull();
  });

  it('shows a load error with Retry', async () => {
    const getById = vi
      .fn()
      .mockRejectedValueOnce(new Error('Database unavailable'))
      .mockResolvedValue(anchor);
    const { fixture, component } = render({ service: { getById } });
    await vi.waitFor(() => expect(component.loadError).toContain('Database unavailable'));
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('app-load-error button:last-of-type')!
      .click();
    await loaded(fixture);

    expect(getById).toHaveBeenCalledTimes(2);
    expect(component.loadError).toBe('');
    await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('H2'));
  });
});
