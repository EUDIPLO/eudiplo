import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { KeyChainResponseDto } from '@eudiplo/sdk-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KeyManagementShowComponent } from './key-management-show.component';

describe('KeyManagementShowComponent', () => {
  let component: KeyManagementShowComponent;
  let fixture: ComponentFixture<KeyManagementShowComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KeyManagementShowComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(KeyManagementShowComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('KeyManagementShowComponent key export', () => {
  const keyChain = { id: 'key', usageType: 'attestation' } as KeyChainResponseDto;
  let keyChainService: { export: ReturnType<typeof vi.fn> };
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let dialog: { open: ReturnType<typeof vi.fn> };
  let roles: string[];

  function create(): KeyManagementShowComponent {
    const component = new KeyManagementShowComponent(
      keyChainService as never,
      {} as never,
      snackBar as never,
      {} as never,
      dialog as never,
      { hasRole: (role: string[]) => role.some((r) => roles.includes(r)) } as never
    );
    component.keyChain = keyChain;
    return component;
  }

  beforeEach(() => {
    keyChainService = { export: vi.fn() };
    snackBar = { open: vi.fn() };
    dialog = { open: vi.fn() };
    roles = [];
  });

  it('does not offer the export without the tenant:admin or tenants:manage role', async () => {
    roles = ['issuance:manage', 'presentation:manage'];
    const component = create();

    expect(component.canExport).toBe(false);
    await component.exportKeyChain();

    expect(keyChainService.export).not.toHaveBeenCalled();
    expect(snackBar.open.mock.lastCall?.[0]).toContain('tenant:admin');
  });

  it.each(['tenant:admin', 'tenants:manage'])('offers the export with %s', (role) => {
    roles = [role];

    expect(create().canExport).toBe(true);
  });

  it('explains a rejected export', async () => {
    roles = ['tenant:admin'];
    keyChainService.export.mockRejectedValue({ statusCode: 403, message: 'Forbidden resource' });

    await create().exportKeyChain();

    expect(snackBar.open.mock.lastCall?.[0]).toContain('tenant:admin');
  });

  it('shows the public key chain as JSON without calling the export', () => {
    create().viewAsJson();

    expect(keyChainService.export).not.toHaveBeenCalled();
    expect(dialog.open.mock.lastCall?.[1].data.jsonData).toBe(keyChain);
  });
});
