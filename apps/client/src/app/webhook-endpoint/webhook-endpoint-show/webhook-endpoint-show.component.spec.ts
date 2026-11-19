import { ApplicationRef } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigDocumentService } from '../../config-portability/config-document.service';
import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';

import { renderDownloadButton } from '../../config-portability/config-document.testing';
import { WebhookEndpointService } from '../webhook-endpoint.service';
import { WebhookEndpointShowComponent } from './webhook-endpoint-show.component';

describe('WebhookEndpointShowComponent', () => {
  const endpoint = {
    id: 'hook',
    name: 'Order events',
    description: 'Shop backend',
    url: 'https://hooks.example.com/orders',
    auth: { type: 'apiKey', config: { headerName: 'X-Key' } },
  };

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  function render(service: Record<string, unknown>) {
    const snackBar = { open: vi.fn() };
    const navigate = vi.fn();
    TestBed.configureTestingModule({
      imports: [WebhookEndpointShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'hook' }) } },
        },
        { provide: WebhookEndpointService, useValue: service },
        { provide: MatSnackBar, useValue: snackBar },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
        {
          provide: ConfigDocumentService,
          useValue: {
            canDownload: () => true,
            isDownloading: () => false,
            downloadWithFeedback: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    });
    TestBed.inject(Router).navigate = navigate;
    const fixture = TestBed.createComponent(WebhookEndpointShowComponent);
    fixture.detectChanges();
    return { fixture, element: fixture.nativeElement as HTMLElement, snackBar, navigate };
  }

  async function loaded(fixture: ComponentFixture<WebhookEndpointShowComponent>) {
    await vi.waitFor(() => expect(fixture.componentInstance.endpoint).toBeDefined());
    fixture.detectChanges();
  }

  it('shows the back link while loading, then the endpoint with its details', async () => {
    let resolve!: (value: unknown) => void;
    const { fixture, element } = render({
      getById: () => new Promise((r) => (resolve = r)) as never,
    });

    const back = element.querySelector('a.back-link');
    expect(back?.getAttribute('aria-label')).toBe('Back to Webhook Endpoints');
    expect(element.querySelector('[aria-label="Loading webhook endpoint"]')).not.toBeNull();

    resolve(endpoint);
    await loaded(fixture);

    expect(element.querySelector('h1')?.textContent?.trim()).toBe('Order events');
    expect(element.querySelector('.hero-meta')?.textContent).toContain('API key');
    expect(element.querySelector('.hero-meta')?.textContent).toContain('ID: hook');
    expect(element.querySelector('.hero-description')?.textContent?.trim()).toBe('Shop backend');
    const details = [...element.querySelectorAll('.detail')].map((detail) => [
      detail.querySelector('dt')?.textContent?.trim(),
      // The URL's copy button is not part of the value.
      (detail.querySelector('dd code') ?? detail.querySelector('dd'))?.textContent?.trim(),
    ]);
    expect(details).toEqual([
      ['URL', 'https://hooks.example.com/orders'],
      ['Type', 'API key'],
      ['Header name', 'X-Key'],
      ['Header value', 'Stored encrypted and never shown'],
    ]);
    expect(element.querySelector('[aria-label="Copy URL"]')).not.toBeNull();
  });

  it('says why the endpoint could not be loaded, and focuses the heading after Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const getById = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404, message: 'Not found' })
      .mockResolvedValue(endpoint);
    const { fixture, element } = render({ getById });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain(
        'Failed to load webhook endpoint: Not found'
      );
    });
    expect(element.querySelector('a.back-link')).not.toBeNull();

    const retry = [...element.querySelectorAll<HTMLButtonElement>('app-load-error button')].find(
      (button) => button.textContent?.includes('Retry')
    )!;
    retry.focus();
    retry.click();
    await loaded(fixture);

    await vi.waitFor(() => {
      TestBed.inject(ApplicationRef).tick();
      expect(document.activeElement).toBe(element.querySelector('h1'));
    });
    expect(fixture.componentInstance.loadError).toBe('');
  });

  it('deletes the endpoint once after confirming and returns to the list', async () => {
    let finish!: () => void;
    const remove = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { fixture, element, snackBar, navigate } = render({
      getById: async () => endpoint as never,
      delete: remove,
    });
    await loaded(fixture);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const button = [...element.querySelectorAll<HTMLButtonElement>('.hero-actions button')].find(
      (b) => b.textContent?.includes('Delete')
    )!;

    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    finish();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('hook');
    expect(snackBar.open).toHaveBeenCalledWith(
      'Webhook endpoint deleted successfully',
      'Close',
      expect.anything()
    );
  });

  it('says when EUDIPLO sends no API key', async () => {
    const { fixture, element } = render({
      getById: async () => ({ ...endpoint, auth: { type: 'none' } }) as never,
    });
    await loaded(fixture);

    expect(element.querySelector('.hero-meta .badge')?.textContent?.trim()).toBe(
      'No authentication'
    );
    expect([...element.querySelectorAll('.detail dt')].map((dt) => dt.textContent?.trim())).toEqual(
      ['URL', 'Type']
    );
  });

  it('copies the URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { fixture, element, snackBar } = render({ getById: async () => endpoint as never });
    await loaded(fixture);

    element.querySelector<HTMLButtonElement>('[aria-label="Copy URL"]')!.click();

    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenCalledWith(
        'URL copied to clipboard',
        'Close',
        expect.anything()
      )
    );
    expect(writeText).toHaveBeenCalledWith('https://hooks.example.com/orders');
  });

  it('says why a delete failed and lets Delete try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const remove = vi.fn().mockRejectedValue({ statusCode: 409, message: 'In use' });
    const { fixture, element, snackBar, navigate } = render({
      getById: async () => endpoint as never,
      delete: remove,
    });
    await loaded(fixture);

    fixture.componentInstance.deleteEndpoint();
    await vi.waitFor(() => expect(fixture.componentInstance.deleting).toBe(false));
    fixture.detectChanges();

    expect(snackBar.open).toHaveBeenCalledWith(
      'Failed to delete webhook endpoint: In use',
      'Close',
      expect.anything()
    );
    expect(navigate).not.toHaveBeenCalled();
    const button = [...element.querySelectorAll<HTMLButtonElement>('.hero-actions button')].find(
      (b) => b.textContent?.includes('Delete')
    )!;
    expect(button.getAttribute('aria-disabled')).not.toBe('true');
    button.click();
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('downloads the configuration document', async () => {
    const { fixture } = render({ getById: async () => endpoint as never });
    await loaded(fixture);

    await fixture.componentInstance.downloadConfig();

    expect(TestBed.inject(ConfigDocumentService).downloadWithFeedback).toHaveBeenCalledWith(
      'WebhookEndpoint',
      'hook'
    );
  });
});

describe('WebhookEndpointShowComponent download button', () => {
  function render(canDownload: boolean, downloadingId = 'hook') {
    return renderDownloadButton(WebhookEndpointShowComponent, {
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'hook' }) } },
        },
        {
          provide: WebhookEndpointService,
          useValue: {
            getById: async () => ({ id: 'hook', name: 'Hook', url: 'https://hooks.example.com' }),
          },
        },
      ],
      loaded: (component) => !!component.endpoint,
      downloading: ['WebhookEndpoint', downloadingId],
      canDownload,
    });
  }

  it('is hidden without a role that may download the document', async () => {
    expect(await render(false)).toBeNull();
  });

  it('is disabled while the document is being downloaded', async () => {
    const button = await render(true);

    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('true');
  });

  it('stays enabled while another endpoint is being downloaded', async () => {
    const button = await render(true, 'other');

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-disabled')).not.toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('false');
  });
});
