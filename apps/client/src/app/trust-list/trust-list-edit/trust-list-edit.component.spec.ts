import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { client } from '@eudiplo/sdk-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TrustListEditComponent } from './trust-list-edit.component';

describe('TrustListEditComponent', () => {
  let component: TrustListEditComponent;
  let fixture: ComponentFixture<TrustListEditComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrustListEditComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(TrustListEditComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('TrustListEditComponent save', () => {
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>;
  const fetchCalls = (method: string) =>
    fetchStub.mock.calls.filter(([input]) => (input as Request).method === method).length;

  beforeEach(() => {
    snackBar = { open: vi.fn() };
    fetchStub = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      const rejected = request.method === 'POST';
      return new Response(
        JSON.stringify(
          rejected
            ? {
                statusCode: 400,
                message: 'Validation failed',
                errors: [
                  { path: ['entities', 0, 'issuerCertPem'], message: 'Invalid PEM' },
                  { path: ['entities', 0, 'info', 'uri'], message: 'Invalid URL' },
                  { path: ['entities', 0, 'type'], message: 'Invalid option' },
                ],
              }
            : []
        ),
        { status: rejected ? 400 : 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    client.setConfig({ fetch: fetchStub });
  });

  afterEach(() => {
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('shows rejected fields under the field, and lists the rest', async () => {
    const component = new TrustListEditComponent(
      { snapshot: { paramMap: { get: () => null } } } as never,
      { navigate: vi.fn() } as never,
      snackBar as never,
      { get: () => ({ destroyed: true }) } as never
    );
    component.ngOnInit();
    component.form.patchValue({ id: 'trust-list' });
    component.addExternalEntity();
    component.entitiesArray.at(0).patchValue({
      issuerCertPem: 'not a pem',
      revocationCertPem: 'not a pem',
      infoName: 'Example',
    });

    const first = component.onSubmit();
    // A second click while the first save runs sends nothing.
    await component.onSubmit();
    await first;

    expect(fetchCalls('POST')).toBe(1);
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to save trust list. Check the highlighted fields. entities.0.type: Invalid option'
    );
    expect(component.fieldError('entities.0.issuerCertPem')).toBe('Invalid PEM');
    expect(component.fieldError('entities.0.infoUri')).toBe('Invalid URL');
    expect(component.saving).toBe(false);

    // The panel opens once and stays open while the user fixes the field.
    const entity = component.entitiesArray.at(0);
    expect(component.rejectedEntities.has(entity)).toBe(true);
    entity.patchValue({ infoUri: 'https://issuer.example' });
    expect(entity.get('infoUri')?.valid).toBe(true);
    expect(component.rejectedEntities.has(entity)).toBe(true);
  });
});
