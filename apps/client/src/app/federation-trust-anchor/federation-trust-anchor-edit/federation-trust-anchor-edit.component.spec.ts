import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerFieldFocus } from '../../common/field-to-fix.util';
import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { IssuanceConfigService } from '../../issuance/issuance-config/issuance-config.service';
import { PresentationManagementService } from '../../presentation/presentation-config/presentation-management.service';
import { JwtService } from '../../services/jwt.service';
import { EditorComponent } from '../../utils/editor/editor.component';
import { EditorStub } from '../../utils/editor/editor.testing';
import { FederationTrustAnchorService } from '../federation-trust-anchor.service';
import { FederationTrustAnchorEditComponent } from './federation-trust-anchor-edit.component';

const jwks = { keys: [{ kty: 'EC' as const, kid: 'ta-2026', crv: 'P-256', x: 'x', y: 'y' }] };
const anchor = {
  id: 'eu-federation',
  tenantId: 'tenant',
  entityId: 'https://ta.example',
  description: 'EU federation',
  jwks,
};

describe('FederationTrustAnchorEditComponent', () => {
  function render(
    params: { id?: string; entityId?: string },
    service: Record<string, unknown>,
    issuanceEntityIds = ['https://ta.example']
  ) {
    TestBed.configureTestingModule({
      imports: [FederationTrustAnchorEditComponent],
      providers: [
        provideRouter([]),
        { provide: FederationTrustAnchorService, useValue: service },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        {
          provide: JwtService,
          useValue: { hasRole: () => true, canUseConfigPortability: () => false },
        },
        {
          provide: IssuanceConfigService,
          useValue: {
            getConfig: async () => ({
              federation: { trustAnchors: issuanceEntityIds.map((entityId) => ({ entityId })) },
            }),
          },
        },
        {
          provide: PresentationManagementService,
          useValue: { loadConfigurations: async () => [] },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap(params.id ? { id: params.id } : {}),
              queryParamMap: convertToParamMap(
                params.entityId ? { entityId: params.entityId } : {}
              ),
            },
          },
        },
      ],
    });
    TestBed.overrideComponent(FederationTrustAnchorEditComponent, {
      remove: { imports: [EditorComponent] },
      add: { imports: [EditorStub] },
    });
    const fixture = TestBed.createComponent(FederationTrustAnchorEditComponent);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const snackBar = { open: vi.spyOn(fixture.debugElement.injector.get(MatSnackBar), 'open') };
    fixture.detectChanges();
    return { fixture, component: fixture.componentInstance, snackBar, navigate };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills in the entity ID a configuration screen links with', () => {
    const { component } = render({ entityId: 'https://ta.example' }, {});

    expect(component.form.controls.entityId.value).toBe('https://ta.example');
    expect(component.form.controls.id.enabled).toBe(true);
  });

  it('registers a trust anchor and opens its page', async () => {
    const create = vi.fn().mockResolvedValue(anchor);
    const { component, navigate } = render({}, { create });
    component.form.setValue({
      id: 'eu-federation',
      entityId: 'https://ta.example ',
      description: '',
      jwks: { $schema: 'x', ...jwks } as never,
    });

    await component.onSubmit();

    expect(create).toHaveBeenCalledWith({
      id: 'eu-federation',
      entityId: 'https://ta.example',
      description: null,
      jwks,
    });
    expect(navigate).toHaveBeenCalledWith(['/federation-trust-anchor', 'eu-federation']);
  });

  it('rejects an entity ID the backend would reject before sending', async () => {
    const create = vi.fn();
    const { component } = render({}, { create });
    component.form.patchValue({ id: 'ta', entityId: 'http://ta.example?x', jwks });

    await component.onSubmit();

    expect(create).not.toHaveBeenCalled();
    expect(component.entityIdError).toBe(
      'Enter an https URL with a host and without query or fragment'
    );
  });

  it('says which fields keep a trust anchor from saving and focuses the first one', async () => {
    const create = vi.fn();
    const { fixture, component, snackBar } = render({}, { create });
    component.form.patchValue({ id: 'ta', jwks });
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    const save = page.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(save.getAttribute('aria-disabled')).toBeNull();

    save.focus();
    save.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement?.getAttribute('formcontrolname')).toBe('entityId');
    });
    expect(snackBar.open).toHaveBeenLastCalledWith(
      'Check the highlighted fields in Trust Anchor.',
      'Close',
      expect.anything()
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('waits while the trust anchor is saved: a second click sends nothing', async () => {
    const create = vi.fn(() => new Promise(() => undefined));
    const { fixture, component } = render({}, { create });
    component.form.patchValue({ id: 'ta', entityId: 'https://ta.example', jwks });
    fixture.detectChanges();
    const save = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[type="submit"]'
    )!;

    save.click();
    fixture.detectChanges();
    save.click();
    await new Promise((resolve) => setTimeout(resolve));

    expect(create).toHaveBeenCalledOnce();
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(
      fixture.debugElement
        .queryAll(By.directive(MatTooltip))
        .find((tooltip) => tooltip.nativeElement === save)!
        .injector.get(MatTooltip).message
    ).toBe('Saving the trust anchor…');
  });

  it('names Federation Keys and focuses the key editor when only the key set is missing', async () => {
    const create = vi.fn();
    const { fixture, component, snackBar } = render({}, { create });
    component.form.patchValue({ id: 'ta', entityId: 'https://ta.example', jwks: null });
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    // Stands in for the editor's own focus, which puts the focus on Monaco's input.
    const focusEditor = vi.fn();
    registerFieldFocus(page.querySelector('app-editor')!, focusEditor);

    page.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(focusEditor).toHaveBeenCalledOnce();
    });
    expect(snackBar.open).toHaveBeenLastCalledWith(
      'Check the highlighted fields in Federation Keys.',
      'Close',
      expect.anything()
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('loads the trust anchor to edit, keeps its ID and sends the changes', async () => {
    const update = vi.fn().mockResolvedValue(anchor);
    const { component, fixture, navigate } = render(
      { id: 'eu-federation' },
      { getById: vi.fn().mockResolvedValue(anchor), update }
    );
    await vi.waitFor(() => expect(component.loading).toBe(false));
    fixture.detectChanges();

    expect(component.form.controls.id.disabled).toBe(true);
    expect(component.form.getRawValue()).toMatchObject({
      id: 'eu-federation',
      entityId: 'https://ta.example',
      description: 'EU federation',
    });
    component.form.controls.description.setValue('Renamed');
    await component.onSubmit();

    expect(update).toHaveBeenCalledWith('eu-federation', {
      entityId: 'https://ta.example',
      description: 'Renamed',
      jwks,
    });
    expect(navigate).toHaveBeenCalledWith(['/federation-trust-anchor', 'eu-federation']);
  });

  it('warns that the change is refused while configurations name the stored entity ID', async () => {
    const { component } = render(
      { id: 'eu-federation' },
      { getById: vi.fn().mockResolvedValue(anchor) }
    );
    await vi.waitFor(() => expect(component.loading).toBe(false));
    expect(component.entityIdChangeWarning).toBe('');

    component.form.controls.entityId.setValue('https://new-ta.example');
    await vi.waitFor(() =>
      expect(component.entityIdChangeWarning).toBe(
        'https://ta.example is named by the issuance configuration, so the change is refused. To' +
          ' move, register the new entity ID as another trust anchor and switch the configurations' +
          ' to it.'
      )
    );
  });

  it('refuses up front to change an entity ID that known configurations name', async () => {
    const update = vi.fn();
    const { component, snackBar } = render(
      { id: 'eu-federation' },
      { getById: vi.fn().mockResolvedValue(anchor), update }
    );
    await vi.waitFor(() => expect(component.loading).toBe(false));
    component.form.controls.entityId.setValue('https://new-ta.example');
    await vi.waitFor(() => expect(component.entityIdChangeBlocked).toBe(true));

    await component.onSubmit();

    expect(snackBar.open.mock.calls[0][0]).toContain('so the change is refused');
    expect(update).not.toHaveBeenCalled();
  });

  it('warns generally when no visible configuration names the stored entity ID', async () => {
    const { component } = render(
      { id: 'eu-federation' },
      { getById: vi.fn().mockResolvedValue(anchor) },
      []
    );
    await vi.waitFor(() => expect(component.loading).toBe(false));

    component.form.controls.entityId.setValue('https://new-ta.example');

    expect(component.entityIdChangeBlocked).toBe(false);
    expect(component.entityIdChangeWarning).toBe(
      'If a configuration names https://ta.example, the change is refused. To move, register the' +
        ' new entity ID as another trust anchor and switch the configurations to it.'
    );
  });

  it('reports a failed update and stays on the form', async () => {
    const update = vi.fn().mockRejectedValue({ statusCode: 409, message: 'Already registered' });
    const { component, navigate, snackBar } = render(
      { id: 'eu-federation' },
      { getById: vi.fn().mockResolvedValue(anchor), update }
    );
    await vi.waitFor(() => expect(component.loading).toBe(false));

    await component.onSubmit();

    expect(snackBar.open.mock.calls[0][0]).toContain('Failed to update the trust anchor');
    expect(snackBar.open.mock.calls[0][0]).toContain('Already registered');
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ['no key', { keys: [] }],
    ['a key without kid', { keys: [{ kty: 'EC' }] }],
    ['another member', { keys: [{ kty: 'EC', kid: 'a' }], extra: true }],
  ])('refuses a JWK set with %s before sending', async (_, value) => {
    const create = vi.fn();
    const { component } = render({}, { create });
    component.form.setValue({
      id: 'ta',
      entityId: 'https://ta.example',
      description: '',
      jwks: value as never,
    });

    await component.onSubmit();

    expect(component.form.controls.jwks.hasError('invalidSchema')).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('shows a load error instead of an empty form', async () => {
    const { component, fixture } = render(
      { id: 'eu-federation' },
      { getById: vi.fn().mockRejectedValue(new Error('Database unavailable')) }
    );
    await vi.waitFor(() => expect(component.loading).toBe(false));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('app-load-error')?.textContent).toContain('Database unavailable');
    expect(element.querySelector('form')).toBeNull();
  });

  it('shows the backend issue of a key at the key editor', async () => {
    const create = vi.fn().mockRejectedValue({
      statusCode: 400,
      message: 'Validation failed',
      errors: [{ path: ['jwks', 'keys', 0, 'd'], message: "'d' is a private key member" }],
    });
    const { component, snackBar } = render({}, { create });
    component.form.setValue({ id: 'ta', entityId: 'https://ta.example', description: '', jwks });

    await component.onSubmit();

    expect(component.jwksError).toBe("'d' is a private key member");
    expect(snackBar.open.mock.calls[0][0]).toBe(
      'Failed to register the trust anchor. Check the highlighted fields.'
    );
  });
});
