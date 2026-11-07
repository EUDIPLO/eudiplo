import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { EMPTY } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { WebhookEndpointService } from '../webhook-endpoint.service';
import { WebhookEndpointCreateComponent } from './webhook-endpoint-create.component';

describe('WebhookEndpointCreateComponent save', () => {
  it('shows rejected fields under the field and sends a double click once', async () => {
    const create = vi.fn().mockRejectedValue({
      statusCode: 400,
      message: 'Validation failed',
      errors: [
        { path: ['url'], message: 'Must be an https URL' },
        { path: ['auth', 'config', 'headerName'], message: 'Invalid header name' },
      ],
    });
    const snackBar = { open: vi.fn() };
    const component = TestBed.runInInjectionContext(
      () =>
        new WebhookEndpointCreateComponent(
          { create } as never,
          { navigate: vi.fn() } as never,
          { snapshot: { paramMap: { get: () => null } } } as never,
          snackBar as never,
          {} as never
        )
    );
    component.form.patchValue({
      id: 'example',
      name: 'Example',
      url: 'http://example.com',
      authType: 'apiKey',
      authHeaderName: 'X Key',
      authHeaderValue: 'secret',
    });

    component.onSubmit();
    component.onSubmit();
    await vi.waitFor(() => expect(component.saving).toBe(false));

    expect(create).toHaveBeenCalledOnce();
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Failed to create webhook endpoint. Check the highlighted fields.'
    );
    expect(component.fieldError('url', 'URL is required')).toBe('Must be an https URL');
    expect(component.fieldError('authHeaderName')).toBe('Invalid header name');

    // Until a rejected field is edited, Save points at it instead of sending the same again.
    component.onSubmit();
    expect(create).toHaveBeenCalledOnce();
    expect(snackBar.open.mock.lastCall?.[0]).toBe(
      'Check the highlighted fields in Endpoint Details, Authentication.'
    );
  });

  it('shows rejected fields when an update is rejected', async () => {
    const update = vi.fn().mockRejectedValue({
      statusCode: 400,
      message: 'Validation failed',
      errors: [{ path: ['url'], message: 'Must be an https URL' }],
    });
    const component = TestBed.runInInjectionContext(
      () =>
        new WebhookEndpointCreateComponent(
          {
            update,
            getById: vi
              .fn()
              .mockResolvedValue({ id: 'example', name: 'Example', url: 'https://a' }),
          } as never,
          { navigate: vi.fn() } as never,
          { snapshot: { paramMap: { get: () => 'example' } } } as never,
          { open: vi.fn() } as never,
          {} as never
        )
    );
    component.ngOnInit();
    await vi.waitFor(() => expect(component.loading).toBe(false));
    component.form.patchValue({ url: 'http://example.com' });

    component.onSubmit();
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    await vi.waitFor(() => expect(component.saving).toBe(false));

    expect(component.fieldError('url', 'URL is required')).toBe('Must be an https URL');
  });

  it('lets Save go again when a rejected header field is hidden by choosing no auth', () => {
    const component = TestBed.runInInjectionContext(
      () =>
        new WebhookEndpointCreateComponent(
          {} as never,
          { navigate: vi.fn() } as never,
          { snapshot: { paramMap: { get: () => null } } } as never,
          { open: vi.fn() } as never,
          {} as never
        )
    );
    component.form.patchValue({
      id: 'example',
      name: 'Example',
      url: 'https://a',
      authType: 'apiKey',
    });
    component.form.get('authHeaderName')?.setErrors({ server: 'Invalid header name' });
    expect(component.form.invalid).toBe(true);

    component.form.patchValue({ authType: 'none' });

    expect(component.form.valid).toBe(true);
  });

  it('does not save while the webhook endpoint to edit loads, nor after its load failed', async () => {
    const update = vi.fn();
    const component = TestBed.runInInjectionContext(
      () =>
        new WebhookEndpointCreateComponent(
          {
            update,
            getById: vi.fn().mockRejectedValue({ statusCode: 404, message: 'Not found' }),
          } as never,
          { navigate: vi.fn() } as never,
          { snapshot: { paramMap: { get: () => 'example' } } } as never,
          { open: vi.fn() } as never,
          {} as never
        )
    );

    component.ngOnInit();
    // A filled, valid form must still not be sent over the stored one.
    component.form.patchValue({ id: 'example', name: 'Example', url: 'https://a' });
    expect(component.form.valid).toBe(true);
    component.onSubmit();
    await vi.waitFor(() => expect(component.loading).toBe(false));
    component.onSubmit();

    expect(component.loadError).toBe('Failed to load webhook endpoint: Not found');
    expect(update).not.toHaveBeenCalled();
  });

  describe('rendered', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('says which fields keep it from saving, focuses the first one and sends nothing', async () => {
      const create = vi.fn();
      const snackBar = { open: vi.fn() };
      await TestBed.configureTestingModule({
        imports: [WebhookEndpointCreateComponent],
        providers: [
          provideRouter([]),
          { provide: WebhookEndpointService, useValue: { create } },
          { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        ],
      })
        // The component imports MatSnackBarModule, whose provider wins over a root provider.
        .overrideProvider(MatSnackBar, { useValue: snackBar })
        .compileComponents();
      const fixture = TestBed.createComponent(WebhookEndpointCreateComponent);
      fixture.detectChanges();
      const page = fixture.nativeElement as HTMLElement;
      fixture.componentInstance.form.patchValue({ id: 'example' });
      fixture.detectChanges();
      const save = [...page.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Create'
      )!;
      expect(save.disabled).toBe(false);
      expect(save.getAttribute('aria-disabled')).toBeNull();

      save.focus();
      save.click();

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.activeElement?.getAttribute('formcontrolname')).toBe('name');
      });
      expect(
        [...page.querySelectorAll('mat-error')].map((error) => error.textContent?.trim())
      ).toEqual(['Name is required', 'URL is required']);
      expect(snackBar.open).toHaveBeenLastCalledWith(
        'Check the highlighted fields in Endpoint Details.',
        'Close',
        expect.anything()
      );
      expect(create).not.toHaveBeenCalled();
    });
  });
});

describe('WebhookEndpointCreateComponent JSON View', () => {
  it('opens JSON View only with the loaded webhook endpoint and says why it waits', async () => {
    const open = vi.fn(() => ({ afterClosed: () => EMPTY }));
    const getById = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 500, message: 'Unavailable' })
      .mockResolvedValue({ id: 'example', name: 'Example', url: 'https://a' });
    const component = TestBed.runInInjectionContext(
      () =>
        new WebhookEndpointCreateComponent(
          { getById } as never,
          { navigate: vi.fn() } as never,
          { snapshot: { paramMap: { get: () => 'example' } } } as never,
          { open: vi.fn() } as never,
          { open } as never
        )
    );

    component.ngOnInit();
    expect(component.jsonViewUnavailableReason).toBe('Wait until the webhook endpoint has loaded');
    // The button stays clickable while it cannot be used, so the handler checks again.
    component.viewAsJson();
    await vi.waitFor(() => expect(component.loading).toBe(false));
    expect(component.jsonViewUnavailableReason).toBe(
      'Retry loading the webhook endpoint before opening JSON View'
    );
    component.viewAsJson();
    expect(open).not.toHaveBeenCalled();

    component.retryLoad();
    await vi.waitFor(() => expect(component.loading).toBe(false));
    expect(component.jsonViewUnavailableReason).toBe('');
    component.viewAsJson();
    expect(open).toHaveBeenCalledOnce();
  });

  it('opens JSON View right away when creating a webhook endpoint, but not while it saves', async () => {
    const open = vi.fn(() => ({ afterClosed: () => EMPTY }));
    let rejectSave!: (error: unknown) => void;
    const create = vi.fn(() => new Promise((_, reject) => (rejectSave = reject)));
    const component = TestBed.runInInjectionContext(
      () =>
        new WebhookEndpointCreateComponent(
          { create } as never,
          { navigate: vi.fn() } as never,
          { snapshot: { paramMap: { get: () => null } } } as never,
          { open: vi.fn() } as never,
          { open } as never
        )
    );

    component.ngOnInit();
    expect(component.loading).toBe(false);
    expect(component.jsonViewUnavailableReason).toBe('');
    component.viewAsJson();
    expect(open).toHaveBeenCalledOnce();

    // A successful save leaves the screen, so the dialog would stay open over the next one.
    component.form.patchValue({ id: 'example', name: 'Example', url: 'https://a' });
    component.onSubmit();
    expect(component.jsonViewUnavailableReason).toBe(
      'Wait until the webhook endpoint has been saved'
    );
    component.viewAsJson();
    expect(open).toHaveBeenCalledOnce();
    rejectSave({ statusCode: 500, message: 'Unavailable' });
    await vi.waitFor(() => expect(component.saving).toBe(false));
    expect(component.jsonViewUnavailableReason).toBe('');
  });
});
