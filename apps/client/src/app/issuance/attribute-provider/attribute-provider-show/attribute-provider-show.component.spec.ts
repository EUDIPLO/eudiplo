import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttributeProviderShowComponent } from './attribute-provider-show.component';
import { renderDownloadButton } from '../../../config-portability/config-document.testing';
import { AttributeProviderService } from '../attribute-provider.service';
import { ActivatedRoute, convertToParamMap } from '@angular/router';

describe('AttributeProviderShowComponent', () => {
  it('says why the provider could not be loaded instead of a blank page, and retries', async () => {
    const getById = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404, message: 'Not found' })
      .mockResolvedValueOnce({ id: 'registry', name: 'Registry', url: 'https://a' });
    const component = new AttributeProviderShowComponent(
      { getById } as never,
      { snapshot: { paramMap: { get: () => 'registry' } } } as never,
      { open: vi.fn() } as never,
      { navigate: vi.fn() } as never,
      {} as never
    );

    component.ngOnInit();
    await vi.waitFor(() =>
      expect(component.loadError).toBe('Failed to load attribute provider: Not found')
    );

    component.load();
    await vi.waitFor(() => expect(component.provider?.id).toBe('registry'));
    expect(component.loadError).toBe('');
  });
});

describe('AttributeProviderShowComponent download', () => {
  it('downloads the configuration document', async () => {
    const downloadWithFeedback = vi.fn().mockResolvedValue(undefined);
    const component = new AttributeProviderShowComponent(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { downloadWithFeedback } as never
    );
    component.provider = { id: 'registry' } as never;

    await component.downloadConfig();

    expect(downloadWithFeedback).toHaveBeenCalledWith('AttributeProvider', 'registry');
  });

  it('disables the button while the document is being downloaded', async () => {
    const button = await renderDownloadButton(AttributeProviderShowComponent, {
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'registry' }) } },
        },
        {
          provide: AttributeProviderService,
          useValue: {
            getById: async () => ({
              id: 'registry',
              name: 'Registry',
              url: 'https://registry.example.com',
            }),
          },
        },
      ],
      loaded: (component) => !!component.provider,
      downloading: ['AttributeProvider', 'registry'],
    });

    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('true');
  });

  it('stays enabled while another resource is being downloaded', async () => {
    const button = await renderDownloadButton(AttributeProviderShowComponent, {
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'registry' }) } },
        },
        {
          provide: AttributeProviderService,
          useValue: {
            getById: async () => ({
              id: 'registry',
              name: 'Registry',
              url: 'https://registry.example.com',
            }),
          },
        },
      ],
      loaded: (component) => !!component.provider,
      downloading: ['AttributeProvider', 'other'],
    });

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-disabled')).not.toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('false');
  });
});

describe('AttributeProviderShowComponent delete', () => {
  function create(
    remove: ReturnType<typeof vi.fn>,
    navigate = vi.fn(),
    snackBar = { open: vi.fn() }
  ) {
    const component = new AttributeProviderShowComponent(
      { delete: remove } as never,
      {} as never,
      snackBar as never,
      { navigate } as never,
      {} as never
    );
    component.provider = { id: 'registry', name: 'Registry' } as never;
    return component;
  }

  afterEach(() => vi.restoreAllMocks());

  it('deletes once after confirming and returns to the list, ignoring a second click', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finish!: () => void;
    const remove = vi.fn(() => new Promise<void>((resolve) => (finish = () => resolve())));
    const navigate = vi.fn();
    const component = create(remove, navigate);

    const first = component.deleteProvider();
    expect(component.deleting).toBe(true);
    await component.deleteProvider();
    finish();
    await first;

    expect(window.confirm).toHaveBeenCalledExactlyOnceWith(
      'Delete attribute provider "Registry"? This cannot be undone.'
    );
    expect(remove).toHaveBeenCalledExactlyOnceWith('registry');
    expect(navigate).toHaveBeenCalledWith(['../'], expect.anything());
    expect(component.deleting).toBe(false);
  });

  it('sends nothing when the question is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const remove = vi.fn();

    await create(remove).deleteProvider();

    expect(remove).not.toHaveBeenCalled();
  });

  it('reports a failed delete with the reason and stays on the page', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const navigate = vi.fn();
    const snackBar = { open: vi.fn() };
    const component = create(
      vi.fn().mockRejectedValue({ statusCode: 409, message: 'In use' }),
      navigate,
      snackBar
    );

    await component.deleteProvider();

    expect(snackBar.open.mock.lastCall?.[0]).toBe('Failed to delete attribute provider: In use');
    expect(navigate).not.toHaveBeenCalled();
    expect(component.deleting).toBe(false);
  });
});
