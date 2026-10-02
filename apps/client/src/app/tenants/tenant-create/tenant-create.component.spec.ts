import '@angular/compiler';
import { FormBuilder } from '@angular/forms';
import { client } from '@eudiplo/sdk-core';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantCreateComponent } from './tenant-create.component';

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

    component = new TenantCreateComponent(
      new FormBuilder(),
      { open: vi.fn() } as never,
      router as never,
      {
        snapshot: { paramMap: { get: vi.fn(() => routeId) } },
      } as never,
      { open: vi.fn(() => ({ afterClosed: () => of(undefined) })) } as never,
      { getBaseUrl: vi.fn(() => 'http://localhost:3000') } as never
    );
  });

  it('omits an empty description from create requests', async () => {
    component.tenantForm.setValue({
      id: ' tenant ',
      name: ' Tenant ',
      description: '   ',
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

  it('trims a non-empty create description', async () => {
    component.tenantForm.setValue({
      id: 'tenant',
      name: 'Tenant',
      description: '  Example tenant  ',
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
});
