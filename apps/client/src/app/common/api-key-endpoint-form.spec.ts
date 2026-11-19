import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipService } from '../config-portability/config-ownership.service';
import { AttributeProviderCreateComponent } from '../issuance/attribute-provider/attribute-provider-create/attribute-provider-create.component';
import { AttributeProviderService } from '../issuance/attribute-provider/attribute-provider.service';
import { WebhookEndpointCreateComponent } from '../webhook-endpoint/webhook-endpoint-create/webhook-endpoint-create.component';
import { WebhookEndpointService } from '../webhook-endpoint/webhook-endpoint.service';

const forms = [
  ['webhook endpoint', WebhookEndpointCreateComponent],
  ['attribute provider', AttributeProviderCreateComponent],
] as const;

function createForm(
  type: (typeof forms)[number][1],
  service: object,
  router = { navigate: vi.fn() }
) {
  const route = { snapshot: { paramMap: { get: () => null } } };
  const component = TestBed.runInInjectionContext(
    () =>
      new type(
        service as never,
        router as never,
        route as never,
        { open: vi.fn() } as never,
        {
          open: vi.fn(),
        } as never
      )
  );
  return { component, route, router };
}

describe.each(forms)('ApiKeyEndpointFormComponent create flow (%s)', (_noun, type) => {
  it('opens the new item on its own page after it was created', async () => {
    const create = vi.fn().mockResolvedValue({});
    const { component, route, router } = createForm(type, { create });
    component.form.patchValue({ id: 'hook-1', name: 'Hook', url: ' https://example.com/hook ' });

    component.onSubmit();
    await vi.waitFor(() => expect(router.navigate).toHaveBeenCalled());

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'hook-1', url: 'https://example.com/hook' })
    );
    expect(router.navigate).toHaveBeenCalledWith(['../', 'hook-1'], { relativeTo: route });
  });
});

describe.each(forms)('ApiKeyEndpointFormComponent URL check (%s)', (_noun, type) => {
  it.each(['https://example.com/hook', 'http://localhost:8080/claims', ' https://a.example '])(
    'accepts the absolute http or https URL %j',
    (url) => {
      const { component } = createForm(type, {});
      component.form.controls.url.setValue(url);

      expect(component.form.controls.url.valid).toBe(true);
    }
  );

  it.each([
    'example.com/hook',
    '/hook',
    'ftp://example.com/hook',
    'mailto:ops@example.com',
    'javascript:alert(1)',
  ])('rejects %j, which the backend would not call, and sends nothing', (url) => {
    const create = vi.fn();
    const { component } = createForm(type, { create });
    component.form.patchValue({ id: 'hook-1', name: 'Hook', url });

    component.onSubmit();

    expect(component.form.controls.url.hasError('url')).toBe(true);
    expect(component.urlError).toBe(
      'Enter an absolute http or https URL, such as https://example.com/path'
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('says the URL is required while it is empty', () => {
    const { component } = createForm(type, {});

    expect(component.urlError).toBe('URL is required');
  });
});

describe('WebhookEndpointCreateComponent URL check rendered', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows under the field why a relative URL cannot be saved', async () => {
    await TestBed.configureTestingModule({
      imports: [WebhookEndpointCreateComponent],
      providers: [
        provideRouter([]),
        { provide: WebhookEndpointService, useValue: { create: vi.fn() } },
        { provide: AttributeProviderService, useValue: {} },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    })
      .overrideProvider(MatSnackBar, { useValue: { open: vi.fn() } })
      .compileComponents();
    const fixture = TestBed.createComponent(WebhookEndpointCreateComponent);
    fixture.detectChanges();
    const url = fixture.componentInstance.form.controls.url;
    url.setValue('example.com/hook');
    url.markAsTouched();
    fixture.detectChanges();

    const errors = [...(fixture.nativeElement as HTMLElement).querySelectorAll('mat-error')].map(
      (error) => error.textContent?.trim()
    );
    expect(errors).toContain(
      'Enter an absolute http or https URL, such as https://example.com/path'
    );
  });
});

describe.each(forms)('ApiKeyEndpointFormComponent edit with a stored URL (%s)', (_noun, type) => {
  it('asks for an http or https URL before saving, as the backend refuses other schemes on update', async () => {
    const getById = vi
      .fn()
      .mockResolvedValue({ id: 'hook-1', name: 'Hook', url: 'ftp://example.com/x' });
    const update = vi.fn();
    const route = { snapshot: { paramMap: { get: () => 'hook-1' } } };
    const component = TestBed.runInInjectionContext(
      () =>
        new type(
          { getById, update } as never,
          { navigate: vi.fn() } as never,
          route as never,
          { open: vi.fn() } as never,
          { open: vi.fn() } as never
        )
    );
    component.ngOnInit();
    await vi.waitFor(() => expect(component.loading).toBe(false));

    component.form.controls.name.setValue('Renamed');
    component.onSubmit();

    expect(update).not.toHaveBeenCalled();
    expect(component.urlError).toBe(
      'Enter an absolute http or https URL, such as https://example.com/path'
    );
  });
});
