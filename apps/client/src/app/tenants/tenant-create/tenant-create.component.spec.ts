import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { client } from '@eudiplo/sdk-core';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuthMode, FrontendConfigService } from '../../services/frontend-config.service';
import { TenantCreateComponent } from './tenant-create.component';

/** A frontend config service that reports `authMode` once loaded. */
function frontendConfig(authMode: AuthMode | null) {
  return { authMode, getConfig: () => Promise.resolve(null) };
}

describe('TenantCreateComponent', () => {
  let component: TenantCreateComponent;
  let routeId: string | null;
  let router: { navigate: ReturnType<typeof vi.fn> };
  let responseBody: unknown;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  async function lastRequest() {
    const request = fetchMock.mock.lastCall?.[0];
    if (!(request instanceof Request)) {
      throw new Error('Expected the SDK to send a Request');
    }
    const text = await request.clone().text();
    return {
      method: request.method,
      path: new URL(request.url).pathname,
      body: text ? JSON.parse(text) : undefined,
    };
  }

  beforeEach(() => {
    routeId = null;
    responseBody = {};
    router = { navigate: vi.fn().mockResolvedValue(true) };
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    client.setConfig({ fetch: fetchMock });

    component = TestBed.runInInjectionContext(
      () =>
        new TenantCreateComponent(
          new FormBuilder(),
          { open: vi.fn() } as never,
          router as never,
          {
            snapshot: { paramMap: { get: vi.fn(() => routeId) } },
          } as never,
          { open: vi.fn(() => ({ afterClosed: () => of(undefined) })) } as never,
          { getBaseUrl: vi.fn(() => 'http://localhost:3000') } as never
        )
    );
  });

  it('omits an empty description from create requests', async () => {
    component.tenantForm.setValue({
      id: ' tenant ',
      name: ' Tenant ',
      description: '   ',
      createAdminClient: true,
      roles: ['clients:manage'],
    });

    await component.onSubmit();

    expect(await lastRequest()).toEqual({
      method: 'POST',
      path: '/api/tenant',
      body: {
        id: 'tenant',
        name: 'Tenant',
        roles: ['clients:manage'],
      },
    });
  });

  it('creates a tenant without an admin client and sends no roles', async () => {
    component.tenantForm.setValue({
      id: 'acme',
      name: 'Acme',
      description: '',
      createAdminClient: true,
      roles: [],
    });
    expect(component.tenantForm.valid).toBe(false);

    component.tenantForm.get('createAdminClient')!.setValue(false);
    expect(component.tenantForm.valid).toBe(true);
    await component.onSubmit();

    expect((await lastRequest()).body).toEqual({ id: 'acme', name: 'Acme' });
  });

  it('asks for roles again when the admin client is turned back on', () => {
    component.tenantForm.patchValue({ id: 'acme', name: 'Acme', roles: [] });
    component.tenantForm.get('createAdminClient')!.setValue(false);
    component.tenantForm.get('createAdminClient')!.setValue(true);

    expect(component.tenantForm.get('roles')!.hasError('required')).toBe(true);
  });

  it.each(['x/../victim', '..', '-tenant', 'tenant a', 'Acme', 'kms.json'])(
    'refuses the tenant ID %j without sending a request',
    async (id) => {
      component.tenantForm.setValue({
        id,
        name: 'Tenant',
        description: '',
        createAdminClient: true,
        roles: ['clients:manage'],
      });

      expect(component.tenantForm.get('id')?.hasError('pattern')).toBe(true);
      await component.onSubmit();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('accepts a valid tenant ID with surrounding spaces and sends it trimmed', async () => {
    component.tenantForm.setValue({
      id: ' acme-1 ',
      name: 'Acme',
      description: '',
      createAdminClient: true,
      roles: ['clients:manage'],
    });

    expect(component.tenantForm.valid).toBe(true);
    await component.onSubmit();
    expect((await lastRequest()).body.id).toBe('acme-1');
  });

  it('trims a non-empty create description', async () => {
    component.tenantForm.setValue({
      id: 'tenant',
      name: 'Tenant',
      description: '  Example tenant  ',
      createAdminClient: true,
      roles: ['clients:manage'],
    });

    await component.onSubmit();

    expect(await lastRequest()).toEqual({
      method: 'POST',
      path: '/api/tenant',
      body: expect.objectContaining({ description: 'Example tenant' }),
    });
  });

  it('omits an untouched description and create-only fields from updates', async () => {
    routeId = 'tenant';
    component.isEditMode = true;
    component.tenantForm.patchValue({
      id: 'tenant',
      name: ' Renamed ',
      description: 'Existing description',
      roles: ['tenants:manage'],
    });
    component.tenantForm.markAsPristine();

    await component.onSubmit();

    expect(await lastRequest()).toEqual({
      method: 'PATCH',
      path: '/api/tenant/tenant',
      body: { name: 'Renamed' },
    });
  });

  it('sends null when an existing description is intentionally cleared', async () => {
    routeId = 'tenant';
    component.isEditMode = true;
    component.tenantForm.patchValue({
      id: 'tenant',
      name: 'Tenant',
      description: 'Existing description',
    });
    component.tenantForm.markAsPristine();
    component.tenantForm.get('description')!.setValue('   ');
    component.tenantForm.get('description')!.markAsDirty();

    await component.onSubmit();

    expect(await lastRequest()).toEqual({
      method: 'PATCH',
      path: '/api/tenant/tenant',
      body: { name: 'Tenant', description: null },
    });
  });

  it('trims an edited update description', async () => {
    routeId = 'tenant';
    component.isEditMode = true;
    component.tenantForm.patchValue({
      id: 'tenant',
      name: 'Tenant',
      description: 'Existing description',
    });
    component.tenantForm.markAsPristine();
    component.tenantForm.get('description')!.setValue('  Updated description  ');
    component.tenantForm.get('description')!.markAsDirty();

    await component.onSubmit();

    expect(await lastRequest()).toEqual({
      method: 'PATCH',
      path: '/api/tenant/tenant',
      body: { name: 'Tenant', description: 'Updated description' },
    });
  });

  it('leaves the form pristine after loading tenant data', async () => {
    responseBody = { id: 'tenant', name: 'Tenant', description: null };

    await (component as unknown as { loadTenant(id: string): Promise<void> }).loadTenant('tenant');

    expect(component.tenantForm.pristine).toBe(true);
    expect(component.tenantForm.get('description')!.value).toBe('');
  });

  it('still saves a tenant whose ID predates the ID rule', async () => {
    routeId = 'Acme';
    component.isEditMode = true;
    responseBody = { id: 'Acme', name: 'Acme', description: null };
    await (component as unknown as { loadTenant(id: string): Promise<void> }).loadTenant('Acme');
    component.tenantForm.get('name')!.setValue('Renamed');
    component.tenantForm.get('name')!.markAsDirty();

    expect(component.tenantForm.valid).toBe(true);
    await component.onSubmit();
    expect(await lastRequest()).toEqual({
      method: 'PATCH',
      path: '/api/tenant/Acme',
      body: { name: 'Renamed' },
    });
  });

  describe('rendered', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('creates no admin client where the identity provider manages the clients', async () => {
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [TenantCreateComponent],
        providers: [
          provideRouter([]),
          { provide: MatSnackBar, useValue: { open: vi.fn() } },
          { provide: FrontendConfigService, useValue: frontendConfig('generic') },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(TenantCreateComponent);
      fixture.detectChanges();
      const page = fixture.nativeElement as HTMLElement;

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(page.textContent).toContain(
          "No admin client is created: this instance's identity provider manages the clients."
        );
      });
      expect(fixture.componentInstance.tenantForm.value.createAdminClient).toBe(false);
      expect(page.querySelector('mat-slide-toggle')).toBeNull();
    });

    it('says which fields keep it from saving, focuses the first one and sends nothing', async () => {
      const snackBar = { open: vi.fn() };
      // The component of the other tests was built with this test module.
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [TenantCreateComponent],
        providers: [
          provideRouter([]),
          { provide: MatSnackBar, useValue: snackBar },
          { provide: FrontendConfigService, useValue: frontendConfig(null) },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(TenantCreateComponent);
      fixture.detectChanges();
      const page = fixture.nativeElement as HTMLElement;
      fixture.componentInstance.tenantForm.patchValue({ name: 'Acme', roles: [] });
      fixture.detectChanges();
      const save = [...page.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Create tenant'
      )!;
      expect(save.disabled).toBe(false);
      expect(save.getAttribute('aria-disabled')).toBeNull();

      save.focus();
      save.click();

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.activeElement?.getAttribute('formcontrolname')).toBe('id');
      });
      expect(
        [...page.querySelectorAll('mat-error')].map((error) => error.textContent?.trim())
      ).toEqual(['tenant ID is required', 'Select at least one role']);
      expect(snackBar.open).toHaveBeenLastCalledWith(
        'Check the highlighted fields.',
        'Close',
        expect.anything()
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('waits while the tenant is saved: a second click sends nothing and the tooltip says why', async () => {
      const pending = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
      client.setConfig({ fetch: pending });
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        imports: [TenantCreateComponent],
        providers: [
          provideRouter([]),
          { provide: MatSnackBar, useValue: { open: vi.fn() } },
          { provide: FrontendConfigService, useValue: frontendConfig(null) },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(TenantCreateComponent);
      fixture.detectChanges();
      fixture.componentInstance.tenantForm.patchValue({ id: 'acme', name: 'Acme' });
      fixture.detectChanges();
      const page = fixture.nativeElement as HTMLElement;
      const save = page.querySelector<HTMLButtonElement>('button[type="submit"]')!;

      save.click();
      fixture.detectChanges();
      save.click();
      await new Promise((resolve) => setTimeout(resolve));

      expect(pending).toHaveBeenCalledOnce();
      expect(save.disabled).toBe(false);
      expect(save.getAttribute('aria-disabled')).toBe('true');
      expect(
        fixture.debugElement
          .queryAll(By.directive(MatTooltip))
          .find((element) => element.nativeElement === save)!
          .injector.get(MatTooltip).message
      ).toBe('Saving the tenant…');
    });

    it('says it is loading a tenant, and why it cannot be edited until a retry loads it', async () => {
      let answer: (response: Response) => void = () => undefined;
      let calls = 0;
      client.setConfig({
        fetch: vi.fn<typeof fetch>(() => {
          calls++;
          return new Promise<Response>((resolve) => (answer = resolve));
        }),
      });
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        providers: [
          provideRouter([{ path: 'tenants/:id/edit', component: TenantCreateComponent }]),
          { provide: MatSnackBar, useValue: { open: vi.fn() } },
        ],
      }).compileComponents();
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/tenants/acme/edit', TenantCreateComponent);
      const page = harness.routeNativeElement as HTMLElement;
      harness.detectChanges();

      expect(page.querySelector('form')).toBeNull();
      expect(page.querySelector('output')?.textContent).toContain('Loading tenant…');

      answer(json(404, { statusCode: 404, message: 'Tenant not found' }));
      await vi.waitFor(() => {
        harness.detectChanges();
        expect(page.querySelector('[role="alert"]')?.textContent).toContain(
          'Failed to load tenant: Tenant not found'
        );
      });
      expect(page.querySelector('form')).toBeNull();

      const retry = [...page.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Retry')
      )!;
      retry.focus();
      retry.click();
      await vi.waitFor(() => expect(calls).toBe(2));
      answer(json(200, { id: 'acme', name: 'Acme', description: null }));

      await vi.waitFor(() => {
        harness.detectChanges();
        expect(page.querySelector<HTMLInputElement>('input[formcontrolname="id"]')?.value).toBe(
          'acme'
        );
      });
      expect(page.querySelector<HTMLInputElement>('input[formcontrolname="id"]')!.disabled).toBe(
        true
      );
      expect(page.querySelector('[role="alert"]')).toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(page.querySelector('h2')));
    });
  });
});
