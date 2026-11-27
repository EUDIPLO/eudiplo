import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigOwnershipDirective } from '../../config-portability/config-ownership.directive';
import { ConfigOwnershipService } from '../../config-portability/config-ownership.service';
import { expectUnavailable, tooltipOf } from '../../common/unavailable-action.testing';
import { JwtService } from '../../services/jwt.service';
import { effectiveRoles } from '../../services/role-grants';
import { keyChainDeleteQuestion } from '../key-chain-delete-question';
import { keyChainRotateQuestion } from '../key-chain-rotate-question';
import { KeyChainService } from '../key-chain.service';
import { KeyManagementListComponent } from './key-management-list.component';
import { grantEveryRole } from '../../common/role-lock.testing';

// The tests are about what the actions do; role locks have their own tests.
beforeEach(() => grantEveryRole());

describe('KeyManagementListComponent', () => {
  let component: KeyManagementListComponent;
  let fixture: ComponentFixture<KeyManagementListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KeyManagementListComponent],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(KeyManagementListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('KeyManagementListComponent loading', () => {
  it('shows why the keys could not be loaded instead of "No keys configured", and retries', async () => {
    const getAll = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 403, message: 'Forbidden resource' })
      .mockResolvedValueOnce([]);
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [KeyManagementListComponent],
      providers: [
        provideRouter([]),
        {
          provide: KeyChainService,
          useValue: { getAll, getDefaultAccess: vi.fn().mockResolvedValue({}) },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeyManagementListComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Failed to load keys: Forbidden resource'
    );
    expect(element.textContent).not.toContain('No keys configured');

    await fixture.componentInstance.loadAllKeys();
    fixture.detectChanges();

    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.textContent).toContain('No keys configured');
  });
});

describe('KeyManagementListComponent delete', () => {
  const item = { id: 'signing', description: 'PID signing' } as never;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the shared question and sends one request when Delete is selected twice', async () => {
    let finish!: () => void;
    const keyChainService = {
      delete: vi.fn().mockReturnValue(new Promise<void>((done) => (finish = done))),
      getAll: vi.fn().mockResolvedValue([]),
    };
    const component = new KeyManagementListComponent(
      keyChainService as never,
      { open: vi.fn() } as never,
      { hasRole: () => true } as never
    );
    vi.spyOn(component, 'loadAllKeys').mockResolvedValue();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const event = { stopPropagation: vi.fn() } as unknown as Event;

    const first = component.deleteItem(item, event);
    expect(component.deletingIds.has('signing')).toBe(true);
    await component.deleteItem(item, event);
    finish();
    await first;

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledWith(keyChainDeleteQuestion('signing', 'PID signing'));
    expect(keyChainService.delete).toHaveBeenCalledTimes(1);
    expect(component.deletingIds.has('signing')).toBe(false);
  });
});

describe('KeyManagementListComponent rotate', () => {
  const keyChain = { id: 'signing', description: 'PID signing', type: 'standalone' };
  const item = { id: 'signing', rotationEnabled: true, keyChain } as never;
  let keyChainService: { rotate: ReturnType<typeof vi.fn> };
  let component: KeyManagementListComponent;
  const event = { stopPropagation: vi.fn() } as unknown as Event;

  beforeEach(() => {
    keyChainService = { rotate: vi.fn().mockResolvedValue(undefined) };
    component = new KeyManagementListComponent(
      keyChainService as never,
      { open: vi.fn() } as never,
      { hasRole: () => true } as never
    );
    vi.spyOn(component, 'loadAllKeys').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the shared question first and does not rotate when it is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    await component.rotateItem(item, event);

    expect(window.confirm).toHaveBeenCalledWith(keyChainRotateQuestion(keyChain as never));
    expect(keyChainService.rotate).not.toHaveBeenCalled();
  });

  it('sends one request when Rotate is selected twice', async () => {
    let finish!: () => void;
    keyChainService.rotate.mockReturnValue(new Promise<void>((done) => (finish = done)));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const first = component.rotateItem(item, event);
    expect(component.rotatingIds.has('signing')).toBe(true);
    await component.rotateItem(item, event);
    finish();
    await first;

    expect(window.confirm).toHaveBeenCalledOnce();
    expect(keyChainService.rotate).toHaveBeenCalledTimes(1);
    expect(component.rotatingIds.has('signing')).toBe(false);
  });
});

describe('KeyManagementListComponent default access key chain', () => {
  const access = (id: string, description: string) => ({
    id,
    description,
    usageType: 'access',
    type: 'standalone',
    kmsProvider: 'db',
    activePublicKey: { kty: 'EC' },
  });

  async function render(keyChainService: Record<string, unknown>) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [KeyManagementListComponent],
      providers: [provideRouter([]), { provide: KeyChainService, useValue: keyChainService }],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeyManagementListComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();
    return fixture;
  }

  it('locks the default actions on the key chain defaults, not the tenant settings', async () => {
    const fixture = await render({
      getAll: vi.fn().mockResolvedValue([access('a', 'Registrar')]),
      getDefaultAccess: vi
        .fn()
        .mockResolvedValue({ defaultAccessKeyChainId: 'a', keyChainId: 'a' }),
      setDefaultAccess: vi.fn(),
    });

    const locks = fixture.debugElement
      .queryAll(By.directive(ConfigOwnershipDirective))
      .map((element) => element.injector.get(ConfigOwnershipDirective))
      .map(({ managedKind, managedResourceId }) => `${managedKind}/${managedResourceId}`);
    // The star of the key chain; the other locks are the key chain's own.
    expect(locks.filter((lock) => lock === 'KeyChainDefaults/defaults')).toHaveLength(1);
    expect(locks.filter((lock) => lock.startsWith('Tenant/'))).toEqual([]);
  });

  it('locks Remove default of a missing default on the key chain defaults', async () => {
    const fixture = await render({
      getAll: vi.fn().mockResolvedValue([access('a', 'Registrar')]),
      getDefaultAccess: vi.fn().mockResolvedValue({ defaultAccessKeyChainId: 'gone' }),
      setDefaultAccess: vi.fn(),
    });

    const remove = fixture.debugElement
      .queryAll(By.directive(ConfigOwnershipDirective))
      .find((element) => element.nativeElement.textContent?.includes('Remove default'));
    expect(remove).toBeDefined();
    const { managedKind, managedResourceId } = remove!.injector.get(ConfigOwnershipDirective);
    expect(`${managedKind}/${managedResourceId}`).toBe('KeyChainDefaults/defaults');
  });

  it('marks the key chain picked by rule and offers to make another one the default', async () => {
    const setDefaultAccess = vi
      .fn()
      .mockResolvedValue({ defaultAccessKeyChainId: 'b', keyChainId: 'b' });
    const fixture = await render({
      getAll: vi.fn().mockResolvedValue([access('a', 'Self-signed'), access('b', 'Registrar')]),
      getDefaultAccess: vi.fn().mockResolvedValue({ keyChainId: 'a' }),
      setDefaultAccess,
    });
    const element = fixture.nativeElement as HTMLElement;

    const chips = [...element.querySelectorAll('.default-chip')].map((chip) =>
      chip.textContent?.split(':')[0].trim()
    );
    expect(chips).toEqual(['Default by rule']);

    const makeDefault = element.querySelector<HTMLButtonElement>(
      'button[aria-label="Use key chain Registrar as default access key chain"]'
    );
    expect(makeDefault).not.toBeNull();
    // The ownership directive blocks clicks until it knows the ownership, so call the handler.
    const component = fixture.componentInstance;
    const event = { stopPropagation: vi.fn() } as unknown as Event;
    await component.toggleDefault(component.displayItems[1], event);
    fixture.detectChanges();

    expect(setDefaultAccess).toHaveBeenCalledWith('b');
    expect(
      [...element.querySelectorAll('.default-chip')].map((chip) =>
        chip.textContent?.split(':')[0].trim()
      )
    ).toEqual(['Default']);
    expect(
      element.querySelector(
        'button[aria-label="Stop using key chain Registrar as default access key chain"]'
      )
    ).not.toBeNull();
  });

  it('removes the configured default with null', async () => {
    const setDefaultAccess = vi.fn().mockResolvedValue({ keyChainId: 'a' });
    const fixture = await render({
      getAll: vi.fn().mockResolvedValue([access('a', 'Registrar')]),
      getDefaultAccess: vi
        .fn()
        .mockResolvedValue({ defaultAccessKeyChainId: 'a', keyChainId: 'a' }),
      setDefaultAccess,
    });

    const component = fixture.componentInstance;
    await component.toggleDefault(component.displayItems[0], {
      stopPropagation: vi.fn(),
    } as unknown as Event);

    expect(setDefaultAccess).toHaveBeenCalledWith(null);
    expect(component.defaultAccess).toEqual({ keyChainId: 'a' });
  });

  it('lists the keys without default marks when the default cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fixture = await render({
      getAll: vi.fn().mockResolvedValue([access('a', 'Registrar')]),
      getDefaultAccess: vi.fn().mockRejectedValue({ statusCode: 500 }),
    });
    const element = fixture.nativeElement as HTMLElement;

    expect(fixture.componentInstance.loadError).toBe('');
    expect(element.textContent).toContain('Registrar');
    expect(element.querySelector('.default-chip')).toBeNull();
    expect(element.querySelector('button[aria-label*="default access key chain"]')).toBeNull();
    vi.restoreAllMocks();
  });

  it('warns when the default access key chain no longer exists and removes it', async () => {
    const setDefaultAccess = vi.fn().mockResolvedValue({ keyChainId: 'a' });
    const fixture = await render({
      getAll: vi.fn().mockResolvedValue([access('a', 'Registrar')]),
      getDefaultAccess: vi.fn().mockResolvedValue({ defaultAccessKeyChainId: 'gone' }),
      setDefaultAccess,
    });
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('.missing-default')?.textContent).toContain(
      'The default access key chain "gone" no longer exists'
    );
    expect(element.querySelector('.default-chip')).toBeNull();

    await fixture.componentInstance.setDefault(null);
    fixture.detectChanges();

    expect(setDefaultAccess).toHaveBeenCalledWith(null);
    expect(element.querySelector('.missing-default')).toBeNull();
  });

  it('refuses to delete the configured default without asking', async () => {
    const remove = vi.fn();
    const fixture = await render({
      getAll: vi.fn().mockResolvedValue([access('a', 'Registrar')]),
      getDefaultAccess: vi
        .fn()
        .mockResolvedValue({ defaultAccessKeyChainId: 'a', keyChainId: 'a' }),
      delete: remove,
    });
    const confirm = vi.spyOn(window, 'confirm');
    const component = fixture.componentInstance;

    await component.deleteItem(component.displayItems[0], {
      stopPropagation: vi.fn(),
    } as unknown as Event);

    expect(confirm).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('keeps the marks when changing the default fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fixture = await render({
      getAll: vi.fn().mockResolvedValue([access('a', 'Self-signed'), access('b', 'Registrar')]),
      getDefaultAccess: vi.fn().mockResolvedValue({ keyChainId: 'a' }),
      setDefaultAccess: vi.fn().mockRejectedValue({ statusCode: 409, message: 'File-managed' }),
    });
    const component = fixture.componentInstance;

    await component.toggleDefault(component.displayItems[1], {
      stopPropagation: vi.fn(),
    } as unknown as Event);

    expect(component.defaultAccess).toEqual({ keyChainId: 'a' });
    expect(component.updatingDefault).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('KeyManagementListComponent filters', () => {
  const chain = (
    id: string,
    usageType: string,
    type: 'standalone' | 'internalChain',
    kmsProvider = 'db'
  ) => ({ id, description: `Key ${id}`, usageType, type, kmsProvider, activePublicKey: {} });

  const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();

  async function render(
    chains = [
      chain('a', 'attestation', 'internalChain'),
      chain('b', 'attestation', 'standalone', 'vault'),
      chain('c', 'statusList', 'standalone'),
    ]
  ) {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [KeyManagementListComponent],
      providers: [
        provideRouter([]),
        {
          provide: KeyChainService,
          useValue: {
            getAll: vi.fn().mockResolvedValue(chains),
            getDefaultAccess: vi.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeyManagementListComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    const names = () => Array.from(page.querySelectorAll('tr.mat-mdc-row .key-link'), text);
    return { fixture, component: fixture.componentInstance, page, names };
  }

  it('offers a chip per usage in use, with its number of key chains', async () => {
    const { page } = await render();

    expect(Array.from(page.querySelectorAll('mat-chip-option'), text)).toEqual([
      'All · 3',
      'Credential Signing · 2',
      'Status List · 1',
    ]);
  });

  it('limits the list by usage, key type and KMS provider, and counts what it shows', async () => {
    const { fixture, component, page, names } = await render();

    component.selectUsage('attestation');
    fixture.detectChanges();
    expect(names()).toEqual(['Key a', 'Key b']);
    expect(text(page.querySelector('.card-title output'))).toBe('2 of 3 key chains');

    component.selectKeyType('standalone');
    fixture.detectChanges();
    expect(names()).toEqual(['Key b']);
    expect(component.keyTypeFilterLabel).toBe('Standalone');

    component.clearFilters();
    component.selectKmsProvider('vault');
    fixture.detectChanges();
    expect(names()).toEqual(['Key b']);
  });

  it('links a key chain whose ID contains a slash as one segment', async () => {
    const { page } = await render([chain('team/key', 'attestation', 'standalone')]);

    expect(page.querySelector('a.key-link')?.getAttribute('href')).toBe('/team%2Fkey');
  });

  it('links each key chain by its name, which keyboard and mouse share', async () => {
    const { page } = await render();

    const row = page.querySelector('tr.mat-mdc-row')!;
    expect(row.querySelector('a.key-link')?.getAttribute('href')).toBe('/a');
    expect(text(row.querySelector('.key-id'))).toBe('a');
    // The actions are not part of the link
    expect(row.querySelector('a.key-link button')).toBeNull();
  });

  it('names the row in Edit, which is a link that opens in a new tab too', async () => {
    const { page } = await render();

    const row = page.querySelector('tr.mat-mdc-row')!;
    const edit = row.querySelector('.key-actions a[mattooltip="Edit"]');
    expect(edit?.getAttribute('href')).toBe('/a/edit');
    expect(edit?.getAttribute('aria-label')).toMatch(/^Edit key chain \S/);
  });
});

describe('KeyManagementListComponent without keys:manage', () => {
  // issuance:manage reads and selects key chains; creating and changing them needs keys:manage.
  const roles = ['issuance:manage'];
  const keyChain = {
    id: 'access',
    description: 'Access',
    usageType: 'access',
    type: 'standalone',
    kmsProvider: 'db',
    rotationPolicy: { enabled: true },
  };

  async function render(): Promise<ComponentFixture<KeyManagementListComponent>> {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [KeyManagementListComponent],
      providers: [
        provideRouter([]),
        {
          provide: KeyChainService,
          useValue: {
            getAll: vi.fn().mockResolvedValue([keyChain]),
            getDefaultAccess: vi.fn().mockResolvedValue({ defaultAccessKeyChainId: null }),
            delete: vi.fn(),
            rotate: vi.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            hasRole: (role: string | string[]) =>
              [role].flat().some((r) => effectiveRoles(roles).includes(r)),
          },
        },
        { provide: ConfigOwnershipService, useValue: { get: async () => undefined } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeyManagementListComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.isLoading).toBe(false));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => vi.restoreAllMocks());

  it('lists the key chains but locks Create key, Edit, Rotate, Delete and the default', async () => {
    const fixture = await render();
    const element = fixture.nativeElement as HTMLElement;
    const reason = 'Needs the keys:manage role';

    expect(fixture.componentInstance.canManageKeyChains).toBe(false);
    expect(element.textContent).toContain('Access');
    const create = element.querySelector<HTMLAnchorElement>('a[mattooltip="Create Key"]')!;
    expect(create.getAttribute('aria-disabled')).toBe('true');
    const edit = element.querySelector('a[aria-label="Edit key chain Access"]')!;
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    expect(tooltipOf(fixture, edit)).toBe(`Edit. ${reason}`);
    expectUnavailable(
      fixture,
      element.querySelector<HTMLButtonElement>('button[aria-label="Rotate key chain Access now"]')!,
      `Rotate key now. ${reason}`
    );
    const remove = element.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete key chain Access"]'
    )!;
    expectUnavailable(fixture, remove, `Delete. ${reason}`);
    expect(element.querySelector('button.default-toggle')?.getAttribute('aria-disabled')).toBe(
      'true'
    );

    const confirm = vi.spyOn(window, 'confirm');
    remove.click();
    expect(confirm).not.toHaveBeenCalled();
    expect(TestBed.inject(KeyChainService).delete).not.toHaveBeenCalled();
  });
});
