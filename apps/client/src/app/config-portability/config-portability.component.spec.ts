import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JwtService } from '../services/jwt.service';
import { ConfigPortabilityComponent } from './config-portability.component';
import {
  ConfigBundle,
  ConfigImportPlan,
  ConfigOperation,
  ConfigPlanItem,
  ConfigPortabilityService,
  ConfigResourceMetadata,
} from './config-portability.service';
import { errorSnackBarDuration } from '../utils/error-snackbar';

/** The arguments of an error snackbar with this text. */
const errorSnackBar = (text: string) =>
  [text, 'Close', { duration: errorSnackBarDuration(text) }] as const;

describe('ConfigPortabilityComponent detaching selected resources', () => {
  let detach: ReturnType<typeof vi.fn>;
  let listResources: ReturnType<typeof vi.fn>;
  let openSnackBar: ReturnType<typeof vi.fn>;
  let component: ConfigPortabilityComponent;

  function resource(kind: string, resourceId: string): ConfigResourceMetadata {
    return { kind, resourceId } as ConfigResourceMetadata;
  }

  beforeEach(() => {
    detach = vi.fn();
    openSnackBar = vi.fn();
    const resources = [
      resource('CredentialConfig', 'pid'),
      resource('TrustList', 'tl-1'),
      resource('WebhookEndpoint', 'hook'),
    ];
    listResources = vi.fn(async () => resources);
    component = new ConfigPortabilityComponent(
      { detach, listResources } as unknown as ConfigPortabilityService,
      { open: openSnackBar } as unknown as MatSnackBar,
      { hasRole: () => true } as unknown as JwtService
    );
    component.resources = resources;
    for (const { kind, resourceId } of resources) component.selected.add(`${kind}/${resourceId}`);
    vi.stubGlobal('confirm', () => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives only the reason when the backend answered none of the requests', async () => {
    detach.mockRejectedValue(new TypeError('Failed to fetch'));
    // Reloading the list fails too; the card reports that, so the summary is the only snackbar.
    listResources.mockRejectedValue(new TypeError('Failed to fetch'));

    await component.detachSelected();

    expect(component.resourcesLoadError).toContain('could not be reached');
    expect(openSnackBar).toHaveBeenCalledTimes(1);
    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Detached 0 of 3 resource(s): the backend could not be reached. ' +
          'Check the connection and try again.'
      )
    );
    expect(component.selected.size).toBe(3);
  });

  it("keeps the backend's reason per resource and gives the unreachable hint once, last", async () => {
    detach
      .mockRejectedValueOnce({ statusCode: 404, message: 'Resource not found' })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(resource('WebhookEndpoint', 'hook'));

    await component.detachSelected();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Detached 1 of 3 resource(s). Failed: CredentialConfig/pid: Resource not found; ' +
          'TrustList/tl-1: the backend could not be reached. Check the connection and try again.'
      )
    );
    expect([...component.selected]).toEqual(['CredentialConfig/pid', 'TrustList/tl-1']);
  });

  it('gives the reason of each resource the backend rejected, without the unreachable hint', async () => {
    detach
      .mockRejectedValueOnce({ statusCode: 404, message: 'Resource not found' })
      // A body without a message, as from a proxy.
      .mockRejectedValueOnce({ statusCode: 502 })
      .mockResolvedValueOnce(resource('WebhookEndpoint', 'hook'));

    await component.detachSelected();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Detached 1 of 3 resource(s). Failed: CredentialConfig/pid: Resource not found; ' +
          'TrustList/tl-1: failed'
      )
    );
  });
});

describe('ConfigPortabilityComponent import plan', () => {
  const bundle = {
    manifest: { format: 'eudiplo.config-bundle' },
    documents: [],
  } as unknown as ConfigBundle;

  /** A plan item for the registrar configuration with these field changes. */
  const registrarUpdate = (changes: ConfigPlanItem['changes']): ConfigPlanItem => ({
    kind: 'RegistrarConfig',
    id: 'registrar',
    action: 'update',
    sourceVersion: 'v1',
    targetVersion: 'v1',
    migrations: [],
    issues: [],
    changes,
  });

  const planWith = (...items: ConfigPlanItem[]): ConfigImportPlan => ({
    tenantId: 'acme',
    mode: 'upsert',
    applicable: true,
    planFingerprint: 'fingerprint',
    items,
    issues: [],
  });

  // As the backend reports leaving out clientSecret and registrationCertificateDefaults.
  const removals = registrarUpdate([
    { path: '/spec/clientSecret', before: '[redacted]', redacted: true },
    {
      path: '/spec/registrationCertificateDefaults/privacy_policy',
      before: 'https://rp.example/privacy',
    },
  ]);

  let portability: {
    plan: ReturnType<typeof vi.fn>;
    import: ReturnType<typeof vi.fn>;
    importArchive: ReturnType<typeof vi.fn>;
    listResources: ReturnType<typeof vi.fn>;
    listOperations: ReturnType<typeof vi.fn>;
    planReattach: ReturnType<typeof vi.fn>;
  };
  let confirm: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ConfigPortabilityComponent>;
  let component: ConfigPortabilityComponent;

  beforeEach(() => {
    portability = {
      plan: vi.fn(),
      import: vi.fn(async () => ({ ...planWith(), operationId: 'operation' })),
      importArchive: vi.fn(async () => ({ ...planWith(), operationId: 'operation' })),
      listResources: vi.fn(async () => []),
      listOperations: vi.fn(async () => []),
      planReattach: vi.fn(),
    };
    confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    TestBed.configureTestingModule({
      imports: [ConfigPortabilityComponent],
      providers: [
        provideRouter([]),
        { provide: ConfigPortabilityService, useValue: portability },
        { provide: JwtService, useValue: { hasRole: () => true } },
      ],
    });
    fixture = TestBed.createComponent(ConfigPortabilityComponent);
    component = fixture.componentInstance;
    component.bundle = bundle;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function planImport(plan: ConfigImportPlan): Promise<HTMLElement> {
    portability.plan.mockResolvedValue(plan);
    await component.planImport();
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  /** The text of each change row: field, current value, value after the import. */
  function changeRows(element: HTMLElement): string[][] {
    return [...element.querySelectorAll('table.changes tr.mat-mdc-row')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => {
        // Icon ligatures are hidden from assistive technology; read the cell without them.
        const text = cell.cloneNode(true) as HTMLElement;
        text.querySelectorAll('mat-icon').forEach((icon) => icon.remove());
        return text.textContent!.trim();
      })
    );
  }

  it('lists the field changes of an update with removed, secret and changed values', async () => {
    const element = await planImport(
      planWith(
        registrarUpdate([
          { path: '/spec/clientSecret', before: '[redacted]', redacted: true },
          { path: '/spec/password', before: '[redacted]', after: '[redacted]', redacted: true },
          {
            path: '/spec/registrarUrl',
            before: 'https://old.example',
            after: 'https://new.example',
          },
          { path: '/spec/retries', after: 3 },
          { path: '/spec/headers', before: '[changed]', after: '[changed]', redacted: true },
          {
            path: '/spec/registrationCertificateDefaults/privacy_policy',
            before: 'https://rp.example/privacy',
          },
        ])
      )
    );

    expect(element.querySelector('h3')?.textContent).toContain(
      'Changes to RegistrarConfig/registrar'
    );
    expect(changeRows(element)).toEqual([
      ['/spec/clientSecret', 'secret', 'removed'],
      ['/spec/password', 'secret', 'secret'],
      ['/spec/registrarUrl', '"https://old.example"', '"https://new.example"'],
      ['/spec/retries', 'not set', '3'],
      ['/spec/headers', 'changed', 'changed'],
      [
        '/spec/registrationCertificateDefaults/privacy_policy',
        '"https://rp.example/privacy"',
        'removed',
      ],
    ]);
    expect(element.querySelector('table.changes th.mat-column-after')?.textContent).toContain(
      'After import'
    );
    expect(element.querySelectorAll('table.changes .removed')).toHaveLength(2);
    expect(element.querySelector('td.mat-column-action')?.textContent).toContain(
      '6 fields, 2 removed'
    );
    expect(element.textContent).toContain(
      'Secret values are not shown, nor values that change between an object, a list and a ' +
        'plain value.'
    );
  });

  it('shows a value that only looks like a redaction marker as it is', async () => {
    const element = await planImport(
      planWith(registrarUpdate([{ path: '/spec/clientId', before: '[redacted]', after: 'client' }]))
    );

    expect(changeRows(element)).toEqual([['/spec/clientId', '"[redacted]"', '"client"']]);
    expect(element.textContent).not.toContain('Secret values');
  });

  it('shows null as a value, not as a removal', async () => {
    const element = await planImport(
      planWith(
        registrarUpdate([
          { path: '/spec/dcql_query/claims/0/path/1', before: 'given', after: null },
        ])
      )
    );

    expect(changeRows(element)).toEqual([['/spec/dcql_query/claims/0/path/1', '"given"', 'null']]);
    expect(element.querySelector('td.mat-column-action')?.textContent).not.toContain('removed');
    await component.applyImport();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('labels the replaced values "Before" once the plan is applied', async () => {
    const element = await planImport(planWith(removals));
    const valueHeader = () =>
      element.querySelector('table.changes th.mat-column-before')?.textContent?.trim();
    expect(valueHeader()).toBe('Current');

    portability.import.mockResolvedValue({ ...planWith(removals), operationId: 'operation' });
    await component.applyImport();
    fixture.detectChanges();

    expect(valueHeader()).toBe('Before');
    expect(element.textContent).toContain('Applied. Operation: operation');
    expect(changeRows(element)).toHaveLength(2);
  });

  it('keeps the stored values "Current" when the backend refuses the apply', async () => {
    const element = await planImport(planWith(removals));
    // A refused apply has an operation, but nothing was written.
    portability.import.mockRejectedValue({
      statusCode: 409,
      code: 'CONFIG_PLAN_STALE',
      message: 'The bundle, mode or target configuration changed.',
      operationId: 'operation',
    });

    await component.applyImport();
    fixture.detectChanges();

    expect(element.querySelector('table.changes th.mat-column-before')?.textContent?.trim()).toBe(
      'Current'
    );
    expect(element.textContent).toContain('Apply failed. Operation: operation');
  });

  it('applies a plan without removals in upsert mode without asking', async () => {
    await planImport(
      planWith(registrarUpdate([{ path: '/spec/clientId', before: 'old', after: 'new' }]))
    );

    await component.applyImport();

    expect(confirm).not.toHaveBeenCalled();
    expect(portability.import).toHaveBeenCalledWith(bundle, 'upsert', false, 'fingerprint');
  });

  it('names the resources whose stored values the import removes before applying', async () => {
    await planImport(planWith(removals));

    await component.applyImport();

    expect(confirm).toHaveBeenCalledWith(
      'The import removes stored values that the bundle leaves out, marked as removed in the ' +
        'plan: RegistrarConfig/registrar (2 fields). This cannot be undone. Continue?'
    );
    expect(portability.import).toHaveBeenCalledWith(bundle, 'upsert', false, 'fingerprint');
  });

  it('names every resource that loses values, with the number of fields', async () => {
    await planImport(
      planWith(
        {
          ...registrarUpdate([{ path: '/spec/description', before: 'old' }]),
          kind: 'KmsConfig',
          id: 'kms',
        },
        removals
      )
    );

    await component.applyImport();

    expect(confirm).toHaveBeenCalledWith(
      'The import removes stored values that the bundle leaves out, marked as removed in the ' +
        'plan: KmsConfig/kms (1 field), RegistrarConfig/registrar (2 fields). ' +
        'This cannot be undone. Continue?'
    );
  });

  it('does not apply the plan when the removal is not confirmed', async () => {
    confirm.mockReturnValue(false);
    await planImport(planWith(removals));

    await component.applyImport();

    expect(portability.import).not.toHaveBeenCalled();
  });

  it('asks once about the resources it deletes and the values it removes in replace mode', async () => {
    component.mode = 'replace';
    const deletion = (kind: string, id: string): ConfigPlanItem => ({
      ...registrarUpdate(undefined),
      kind,
      id,
      action: 'delete',
    });
    await planImport(
      planWith(removals, deletion('CredentialConfig', 'pid'), deletion('TrustList', 'tl-1'))
    );

    await component.applyImport();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      'Replace mode deletes file-managed resources from this bundle source that are not in the ' +
        'bundle: CredentialConfig/pid, TrustList/tl-1. The import removes stored values that the ' +
        'bundle leaves out, marked as removed in the plan: RegistrarConfig/registrar (2 fields). ' +
        'This cannot be undone. Continue?'
    );
    expect(portability.import).toHaveBeenCalledWith(bundle, 'replace', true, 'fingerprint');
  });

  it('asks before every replace import, also when it deletes and removes nothing', async () => {
    component.mode = 'replace';
    confirm.mockReturnValue(false);
    await planImport(
      planWith(registrarUpdate([{ path: '/spec/clientId', before: 'a', after: 'b' }]))
    );

    await component.applyImport();

    expect(confirm).toHaveBeenCalledWith('This replace import deletes no resources. Continue?');
    expect(portability.import).not.toHaveBeenCalled();
  });

  it('confirms the replacement when it applies a ZIP bundle', async () => {
    const archive = new File(['zip'], 'bundle.zip');
    component.bundle = undefined;
    component.bundleArchive = archive;
    component.mode = 'replace';
    component.plan = planWith();

    await component.applyImport();

    expect(confirm).toHaveBeenCalledWith('This replace import deletes no resources. Continue?');
    expect(portability.importArchive).toHaveBeenCalledWith(archive, 'replace', true, 'fingerprint');
  });

  it('lists the changes of a reset to the file version', async () => {
    // jsdom has no scrollIntoView; the reset plan scrolls itself into view.
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    });
    portability.planReattach.mockResolvedValue(planWith(removals));

    try {
      await component.planReattach({
        kind: 'RegistrarConfig',
        resourceId: 'registrar',
      } as ConfigResourceMetadata);
      fixture.detectChanges();
      const element = fixture.nativeElement as HTMLElement;

      expect(element.querySelector('table.changes th.mat-column-after')?.textContent).toContain(
        'After reset'
      );
      expect(changeRows(element)).toHaveLength(2);
      await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});

describe('ConfigPortabilityComponent applying a file-managed client from file', () => {
  let reattach: ReturnType<typeof vi.fn>;
  let openSnackBar: ReturnType<typeof vi.fn>;
  let confirm: ReturnType<typeof vi.fn>;
  let component: ConfigPortabilityComponent;

  const folderClient = {
    kind: 'Client',
    resourceId: 'folder-client',
    ownership: 'file-managed',
    source: 'folder:/app/config/demo',
  } as unknown as ConfigResourceMetadata;

  beforeEach(() => {
    reattach = vi.fn(async () => ({
      applicable: true,
      items: [],
      generatedSecrets: [{ id: 'folder-client', value: 'secret' }],
    }));
    openSnackBar = vi.fn();
    confirm = vi.fn(() => true);
    component = new ConfigPortabilityComponent(
      {
        reattach,
        listResources: vi.fn(async () => [folderClient]),
        listOperations: vi.fn(async () => []),
      } as unknown as ConfigPortabilityService,
      { open: openSnackBar } as unknown as MatSnackBar,
      { hasRole: () => true } as unknown as JwtService
    );
    vi.stubGlobal('confirm', confirm);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers it only for file-managed clients from the config folder', () => {
    expect(component.canApplyFromFile(folderClient)).toBe(true);
    expect(
      component.canApplyFromFile({
        ...folderClient,
        source: 'bundle:demo',
      } as ConfigResourceMetadata)
    ).toBe(false);
    expect(
      component.canApplyFromFile({
        ...folderClient,
        ownership: 'detached',
      } as ConfigResourceMetadata)
    ).toBe(false);
    expect(
      component.canApplyFromFile({ ...folderClient, kind: 'KeyChain' } as ConfigResourceMetadata)
    ).toBe(false);
  });

  function planFor(changes: { path: string }[]): ConfigImportPlan {
    return {
      applicable: true,
      planFingerprint: 'a'.repeat(64),
      items: [{ kind: 'Client', id: 'folder-client', action: 'update', changes }],
    } as unknown as ConfigImportPlan;
  }

  it('warns that the current secret stops working and shows the new one', async () => {
    component.reattachTarget = folderClient;
    component.plan = planFor([{ path: '/spec/secret' }]);

    await component.applyReattach();

    expect(confirm).toHaveBeenCalledWith(
      'Apply Client/folder-client from the config folder again? folder-client gets a new secret, ' +
        'and its current secret stops working immediately.'
    );
    expect(reattach).toHaveBeenCalledWith('Client', 'folder-client', 'a'.repeat(64));
    expect(component.generatedSecrets).toEqual([{ id: 'folder-client', value: 'secret' }]);
    expect(openSnackBar).toHaveBeenCalledWith(
      'Client/folder-client was applied from the file',
      'Close',
      { duration: 3000 }
    );
  });

  it('does not warn about the secret when the plan keeps it', async () => {
    component.reattachTarget = folderClient;
    component.plan = planFor([{ path: '/spec/description' }]);

    await component.applyReattach();

    expect(confirm).toHaveBeenCalledWith(
      'Apply Client/folder-client from the config folder again?'
    );
  });

  it('warns about the secret when resetting a detached client too', async () => {
    component.reattachTarget = { ...folderClient, ownership: 'detached' } as ConfigResourceMetadata;
    component.plan = planFor([{ path: '/spec/secret' }]);

    await component.applyReattach();

    expect(confirm).toHaveBeenCalledWith(
      'Reset Client/folder-client to the file version? Changes made through the API or UI are ' +
        'discarded. folder-client gets a new secret, and its current secret stops working immediately.'
    );
    expect(openSnackBar).toHaveBeenCalledWith(
      'Client/folder-client is file-managed again',
      'Close',
      {
        duration: 3000,
      }
    );
  });

  it('applies nothing when the confirmation is cancelled', async () => {
    confirm.mockReturnValue(false);
    component.reattachTarget = folderClient;
    component.plan = planFor([{ path: '/spec/secret' }]);

    await component.applyReattach();

    expect(reattach).not.toHaveBeenCalled();
  });

  it('does not count a client the plan creates, which has no current secret', () => {
    component.reattachTarget = { ...folderClient, ownership: 'detached' } as ConfigResourceMetadata;
    component.plan = planFor([{ path: '/spec/secret' }]);
    component.plan.items[0].action = 'create';

    expect(component.planRegeneratesClientSecret).toBe(false);
  });

  it('keeps a shown secret when the next plan replaces the applied one, until dismissed', async () => {
    component.reattachTarget = folderClient;
    component.plan = planFor([{ path: '/spec/secret' }]);
    await component.applyReattach();
    (component as unknown as { portability: { planReattach: unknown } }).portability.planReattach =
      vi.fn(async () => planFor([]));

    await component.planReattach({ ...folderClient, resourceId: 'other-client' });

    expect(component.generatedSecrets).toEqual([{ id: 'folder-client', value: 'secret' }]);
    confirm.mockReturnValue(false);
    component.dismissGeneratedSecrets();
    expect(component.generatedSecrets).toHaveLength(1);
    confirm.mockReturnValue(true);
    component.dismissGeneratedSecrets();
    expect(component.generatedSecrets).toEqual([]);
  });

  it('names applying, not resetting, when planning Apply from file fails', async () => {
    (component as unknown as { portability: { planReattach: unknown } }).portability.planReattach =
      vi.fn(async () => {
        throw {};
      });

    await component.planReattach(folderClient);

    expect(openSnackBar).toHaveBeenCalledWith(
      expect.stringContaining('Could not plan applying the file version'),
      'Close',
      expect.anything()
    );
  });
});

describe('ConfigPortabilityComponent template for Apply from file', () => {
  const resources = [
    {
      kind: 'Client',
      resourceId: 'folder-client',
      ownership: 'file-managed',
      source: 'folder:/app/config/demo',
      generation: 1,
    },
    {
      kind: 'Client',
      resourceId: 'bundle-client',
      ownership: 'file-managed',
      source: 'bundle:demo',
      generation: 1,
    },
  ] as unknown as ConfigResourceMetadata[];

  async function render() {
    TestBed.configureTestingModule({
      imports: [ConfigPortabilityComponent],
      providers: [
        provideRouter([]),
        {
          provide: ConfigPortabilityService,
          useValue: {
            listResources: vi.fn(async () => resources),
            listOperations: vi.fn(async () => []),
          },
        },
        { provide: JwtService, useValue: { hasRole: () => true } },
      ],
    });
    const fixture = TestBed.createComponent(ConfigPortabilityComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const buttons = (element: HTMLElement, label: string) =>
    [...element.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === label
    );

  it('offers Apply from file only in the row of the folder client', async () => {
    const fixture = await render();
    const element = fixture.nativeElement as HTMLElement;

    expect(buttons(element, 'Apply from file')).toHaveLength(1);
    expect(buttons(element, 'Apply from file')[0].closest('tr')?.textContent).toContain(
      'folder-client'
    );
  });

  it('titles the plan and announces the new secret only while the plan changes it', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    const element = fixture.nativeElement as HTMLElement;
    component.reattachTarget = resources[0];
    component.plan = {
      applicable: true,
      planFingerprint: 'a'.repeat(64),
      issues: [],
      items: [
        {
          kind: 'Client',
          id: 'folder-client',
          action: 'update',
          issues: [],
          migrations: [],
          changes: [{ path: '/spec/secret' }],
        },
      ],
    } as unknown as ConfigImportPlan;
    fixture.detectChanges();

    expect(element.textContent).toContain('Apply Client/folder-client from file');
    expect(element.textContent).toContain('New secret');
    expect(element.querySelector('table.changes th.mat-column-after')?.textContent).toContain(
      'After apply'
    );

    component.plan = { ...component.plan, operationId: 'operation-1' };
    fixture.detectChanges();
    expect(element.textContent).not.toContain('New secret');
  });
});

describe('ConfigPortabilityComponent template for Reset to file', () => {
  const row = (kind: string, resourceId: string, ownership: string, source?: string) => ({
    kind,
    resourceId,
    ownership,
    source,
    generation: 2,
  });
  const resources = [
    row('PresentationConfig', 'folder-detached', 'detached', 'folder:/app/config/demo'),
    row('PresentationConfig', 'bundle-detached', 'detached', 'bundle:demo'),
    row('PresentationConfig', 'api-changed', 'unmanaged'),
    row('Tenant', 'tenant', 'detached', 'folder:/app/config/demo'),
  ] as unknown as ConfigResourceMetadata[];

  async function render(rows: ConfigResourceMetadata[]) {
    TestBed.configureTestingModule({
      imports: [ConfigPortabilityComponent],
      providers: [
        provideRouter([]),
        {
          provide: ConfigPortabilityService,
          useValue: {
            listResources: vi.fn(async () => rows),
            listOperations: vi.fn(async () => []),
          },
        },
        { provide: JwtService, useValue: { hasRole: () => true } },
      ],
    });
    const fixture = TestBed.createComponent(ConfigPortabilityComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const resetRows = (element: HTMLElement) =>
    [...element.querySelectorAll('button')]
      .filter((button) => button.textContent?.trim() === 'Reset to file')
      .map((button) => button.closest('tr')?.textContent ?? '');

  it('offers Reset to file for folder resources and detached tenant settings', async () => {
    const element = (await render(resources)).nativeElement as HTMLElement;

    const rows = resetRows(element);
    expect(rows).toHaveLength(3);
    expect(rows.some((text) => text.includes('folder-detached'))).toBe(true);
    expect(rows.some((text) => text.includes('api-changed'))).toBe(true);
    expect(rows.some((text) => text.includes('Tenant'))).toBe(true);
    expect(rows.some((text) => text.includes('bundle-detached'))).toBe(false);
  });

  it('offers no Reset to file for tenant settings or key chain defaults changed through the API', async () => {
    const element = (
      await render([
        row('Tenant', 'tenant', 'unmanaged'),
        row('KeyChainDefaults', 'defaults', 'unmanaged'),
      ] as unknown as ConfigResourceMetadata[])
    ).nativeElement as HTMLElement;

    expect(resetRows(element)).toEqual([]);
  });

  it('offers Reset to file for detached key chain defaults', async () => {
    const element = (
      await render([
        row('KeyChainDefaults', 'defaults', 'detached', 'folder:/app/config/demo'),
      ] as unknown as ConfigResourceMetadata[])
    ).nativeElement as HTMLElement;

    expect(resetRows(element)).toHaveLength(1);
  });
});

describe('ConfigPortabilityComponent resource ownership load states', () => {
  const resources = [
    {
      kind: 'PresentationConfig',
      resourceId: 'pid',
      ownership: 'file-managed',
      source: 'folder:/app/config/demo',
      generation: 1,
    },
  ] as unknown as ConfigResourceMetadata[];
  const emptyText = 'No resource ownership metadata has been recorded yet.';

  let listResources: ReturnType<typeof vi.fn>;
  let openSnackBar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listResources = vi.fn();
    openSnackBar = vi.fn();
    vi.stubGlobal('confirm', () => true);
    TestBed.configureTestingModule({
      imports: [ConfigPortabilityComponent],
      providers: [
        provideRouter([]),
        {
          provide: ConfigPortabilityService,
          useValue: {
            listResources,
            listOperations: vi.fn(async () => []),
            detach: vi.fn(async () => undefined),
          },
        },
        { provide: JwtService, useValue: { hasRole: () => true } },
        { provide: MatSnackBar, useValue: { open: openSnackBar } },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function render() {
    const fixture = TestBed.createComponent(ConfigPortabilityComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  /** The content of the Resource ownership card. */
  const card = (fixture: ComponentFixture<ConfigPortabilityComponent>) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('mat-card')].find((element) =>
      element.querySelector('mat-card-title')?.textContent?.includes('Resource ownership')
    )!;

  const retryButton = (fixture: ComponentFixture<ConfigPortabilityComponent>) =>
    [...card(fixture).querySelectorAll<HTMLButtonElement>('app-load-error button')].find((button) =>
      button.textContent?.includes('Retry')
    )!;

  it('shows a labelled spinner, not the empty text, while loading', async () => {
    listResources.mockReturnValue(new Promise(() => undefined));
    const fixture = TestBed.createComponent(ConfigPortabilityComponent);
    fixture.detectChanges();

    const spinner = card(fixture).querySelector('mat-spinner');
    expect(spinner?.getAttribute('aria-label')).toBe('Loading resource ownership');
    expect(card(fixture).textContent).not.toContain(emptyText);
    expect(card(fixture).querySelector('app-load-error')).toBeNull();
  });

  it('shows the reason with a Retry instead of the empty text when loading fails', async () => {
    listResources.mockRejectedValue({ statusCode: 500, message: 'Database unavailable' });
    const fixture = await render();

    expect(card(fixture).querySelector('app-load-error')?.textContent).toContain(
      'Database unavailable'
    );
    expect(retryButton(fixture)).toBeDefined();
    expect(card(fixture).textContent).not.toContain(emptyText);
    expect(card(fixture).querySelector('mat-spinner')).toBeNull();
    // The card reports the failure; a snackbar would say it twice.
    expect(openSnackBar).not.toHaveBeenCalled();
  });

  it('shows the empty text only after a successful load', async () => {
    listResources.mockResolvedValue([]);
    const fixture = await render();

    expect(card(fixture).textContent).toContain(emptyText);
    expect(card(fixture).querySelector('mat-spinner')).toBeNull();
    expect(card(fixture).querySelector('app-load-error')).toBeNull();
  });

  /** A promise the test settles after the component has rendered its loading state. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  it('loads again on Retry and moves the focus from the removed Retry to the card title', async () => {
    listResources.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const reload = deferred<ConfigResourceMetadata[]>();
    listResources.mockReturnValueOnce(reload.promise);
    const fixture = await render();
    retryButton(fixture).focus();

    retryButton(fixture).click();
    fixture.detectChanges();
    // The spinner replaced the error card with its focused Retry.
    expect(card(fixture).querySelector('mat-spinner')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    reload.resolve(resources);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(listResources).toHaveBeenCalledTimes(2);
    expect(card(fixture).querySelector('app-load-error')).toBeNull();
    expect(card(fixture).querySelector('table')?.textContent).toContain('pid');
    expect(document.activeElement).toBe(card(fixture).querySelector('mat-card-title'));
  });

  it('gives the focus to the Retry of a new error card when the retry fails again', async () => {
    listResources.mockRejectedValueOnce({ statusCode: 500, message: 'Database unavailable' });
    const reload = deferred<ConfigResourceMetadata[]>();
    listResources.mockReturnValueOnce(reload.promise);
    const fixture = await render();
    const firstRetry = retryButton(fixture);
    firstRetry.focus();

    firstRetry.click();
    fixture.detectChanges();
    reload.reject({ statusCode: 500, message: 'Database unavailable' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(listResources).toHaveBeenCalledTimes(2);
    expect(card(fixture).textContent).not.toContain(emptyText);
    expect(retryButton(fixture)).not.toBe(firstRetry);
    expect(document.activeElement).toBe(retryButton(fixture));
  });

  it('shows the spinner, not the rows of an earlier load, during a retry', async () => {
    listResources.mockResolvedValueOnce(resources);
    listResources.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    listResources.mockReturnValueOnce(new Promise(() => undefined));
    const fixture = await render();
    await fixture.componentInstance.detach(resources[0]);
    fixture.detectChanges();

    retryButton(fixture).click();
    fixture.detectChanges();

    expect(card(fixture).querySelector('mat-spinner')).not.toBeNull();
    expect(card(fixture).querySelector('table')).toBeNull();
  });

  it('keeps the table while reloading after an action', async () => {
    listResources.mockResolvedValueOnce(resources);
    listResources.mockReturnValueOnce(new Promise(() => undefined));
    const fixture = await render();

    void fixture.componentInstance.detach(resources[0]);
    await vi.waitFor(() => expect(listResources).toHaveBeenCalledTimes(2));
    fixture.detectChanges();

    expect(card(fixture).querySelector('table')?.textContent).toContain('pid');
    expect(card(fixture).querySelector('mat-spinner')).toBeNull();
  });

  it('replaces the table with the error card when the reload after an action fails', async () => {
    listResources.mockResolvedValueOnce(resources);
    listResources.mockRejectedValueOnce({ statusCode: 500, message: 'Database unavailable' });
    const fixture = await render();

    await fixture.componentInstance.detach(resources[0]);
    fixture.detectChanges();

    expect(card(fixture).querySelector('app-load-error')?.textContent).toContain(
      'Database unavailable'
    );
    expect(card(fixture).querySelector('table')).toBeNull();
    expect(openSnackBar).not.toHaveBeenCalled();
  });

  it('shows only the result of the latest load when a Retry overlaps a reload', async () => {
    const stale = deferred<ConfigResourceMetadata[]>();
    listResources.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    listResources.mockReturnValueOnce(stale.promise);
    listResources.mockResolvedValueOnce(resources);
    const fixture = await render();
    const component = fixture.componentInstance;

    // The reload after a detach is still running when the user retries.
    const detaching = component.detach(resources[0]);
    await vi.waitFor(() => expect(listResources).toHaveBeenCalledTimes(2));
    await component.retryResources();
    stale.reject(new TypeError('Failed to fetch'));
    await detaching;
    fixture.detectChanges();

    expect(component.resourcesLoadError).toBe('');
    expect(card(fixture).querySelector('table')?.textContent).toContain('pid');
  });

  it('keeps the rows of a Retry when an older reload succeeds after it', async () => {
    const older = deferred<ConfigResourceMetadata[]>();
    listResources.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    listResources.mockReturnValueOnce(older.promise);
    listResources.mockResolvedValueOnce(resources);
    const fixture = await render();
    const component = fixture.componentInstance;

    const detaching = component.detach(resources[0]);
    await vi.waitFor(() => expect(listResources).toHaveBeenCalledTimes(2));
    await component.retryResources();
    older.resolve([
      { ...resources[0], resourceId: 'outdated' } as unknown as ConfigResourceMetadata,
    ]);
    await detaching;
    fixture.detectChanges();

    const table = card(fixture).querySelector('table')?.textContent;
    expect(table).toContain('pid');
    expect(table).not.toContain('outdated');
  });

  it('keeps the spinner of a pending Retry when an older reload finishes first', async () => {
    const older = deferred<ConfigResourceMetadata[]>();
    listResources.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    listResources.mockReturnValueOnce(older.promise);
    listResources.mockReturnValueOnce(new Promise(() => undefined));
    const fixture = await render();
    const component = fixture.componentInstance;

    const detaching = component.detach(resources[0]);
    await vi.waitFor(() => expect(listResources).toHaveBeenCalledTimes(2));
    void component.retryResources();
    older.resolve([]);
    await detaching;
    fixture.detectChanges();

    expect(card(fixture).querySelector('mat-spinner')).not.toBeNull();
    expect(card(fixture).textContent).not.toContain(emptyText);
  });

  it('leaves the focus where the user moved it during the retry', async () => {
    listResources.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    let resolve!: (value: ConfigResourceMetadata[]) => void;
    listResources.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    const fixture = await render();
    retryButton(fixture).focus();

    retryButton(fixture).click();
    fixture.detectChanges();
    const exportButton = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ].find((button) => button.textContent?.includes('Download bundle'))!;
    exportButton.focus();
    resolve(resources);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(document.activeElement).toBe(exportButton);
  });
});

describe('ConfigPortabilityComponent operation history load states', () => {
  const resources = [
    {
      kind: 'PresentationConfig',
      resourceId: 'pid',
      ownership: 'file-managed',
      source: 'folder:/app/config/demo',
      generation: 1,
    },
  ] as unknown as ConfigResourceMetadata[];
  const operation = (id: string): ConfigOperation => ({
    id,
    mode: 'upsert',
    status: 'succeeded',
    createdAt: '2026-10-30T12:00:00.000Z',
    operations: [],
  });
  const emptyText = 'No configuration operations recorded.';

  let listOperations: ReturnType<typeof vi.fn>;
  let openSnackBar: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listOperations = vi.fn();
    openSnackBar = vi.fn();
    vi.stubGlobal('confirm', () => true);
    TestBed.configureTestingModule({
      imports: [ConfigPortabilityComponent],
      providers: [
        provideRouter([]),
        {
          provide: ConfigPortabilityService,
          useValue: {
            listResources: vi.fn(async () => resources),
            listOperations,
            detach: vi.fn(async () => undefined),
          },
        },
        { provide: JwtService, useValue: { hasRole: () => true } },
        { provide: MatSnackBar, useValue: { open: openSnackBar } },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function render() {
    const fixture = TestBed.createComponent(ConfigPortabilityComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  /** The Recent configuration operations card. */
  const card = (fixture: ComponentFixture<ConfigPortabilityComponent>) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('mat-card')].find((element) =>
      element.querySelector('mat-card-title')?.textContent?.includes('Recent configuration')
    )!;

  const retryButton = (fixture: ComponentFixture<ConfigPortabilityComponent>) =>
    [...card(fixture).querySelectorAll<HTMLButtonElement>('app-load-error button')].find((button) =>
      button.textContent?.includes('Retry')
    )!;

  /** A promise the test settles after the component has rendered its loading state. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  it('shows a labelled spinner, not the empty text, while loading', () => {
    listOperations.mockReturnValue(new Promise(() => undefined));
    const fixture = TestBed.createComponent(ConfigPortabilityComponent);
    fixture.detectChanges();

    const spinner = card(fixture).querySelector('mat-spinner');
    expect(spinner?.getAttribute('aria-label')).toBe('Loading configuration operations');
    expect(card(fixture).textContent).not.toContain(emptyText);
    expect(card(fixture).querySelector('app-load-error')).toBeNull();
  });

  it('shows the reason with a Retry instead of the empty text when loading fails', async () => {
    listOperations.mockRejectedValue({ statusCode: 500, message: 'Database unavailable' });
    const fixture = await render();

    expect(card(fixture).querySelector('app-load-error')?.textContent).toContain(
      'Database unavailable'
    );
    expect(retryButton(fixture)).toBeDefined();
    expect(card(fixture).textContent).not.toContain(emptyText);
    expect(card(fixture).querySelector('mat-spinner')).toBeNull();
    // The card reports the failure; a snackbar would say it twice.
    expect(openSnackBar).not.toHaveBeenCalled();
  });

  it('shows the empty text only after a successful load', async () => {
    listOperations.mockResolvedValue([]);
    const fixture = await render();

    expect(card(fixture).textContent).toContain(emptyText);
    expect(card(fixture).querySelector('mat-spinner')).toBeNull();
    expect(card(fixture).querySelector('app-load-error')).toBeNull();
  });

  it('loads again on Retry and moves the focus from the removed Retry to the card title', async () => {
    listOperations.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const reload = deferred<ConfigOperation[]>();
    listOperations.mockReturnValueOnce(reload.promise);
    const fixture = await render();
    retryButton(fixture).focus();

    retryButton(fixture).click();
    fixture.detectChanges();
    // The spinner replaced the error card with its focused Retry.
    expect(card(fixture).querySelector('mat-spinner')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    reload.resolve([operation('op-1')]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(listOperations).toHaveBeenCalledTimes(2);
    expect(card(fixture).querySelector('app-load-error')).toBeNull();
    expect(card(fixture).textContent).toContain('op-1');
    expect(document.activeElement).toBe(card(fixture).querySelector('mat-card-title'));
  });

  it('gives the focus to the Retry of a new error card when the retry fails again', async () => {
    listOperations.mockRejectedValueOnce({ statusCode: 500, message: 'Database unavailable' });
    const reload = deferred<ConfigOperation[]>();
    listOperations.mockReturnValueOnce(reload.promise);
    const fixture = await render();
    const firstRetry = retryButton(fixture);
    firstRetry.focus();

    firstRetry.click();
    fixture.detectChanges();
    reload.reject({ statusCode: 500, message: 'Database unavailable' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(listOperations).toHaveBeenCalledTimes(2);
    expect(card(fixture).textContent).not.toContain(emptyText);
    expect(retryButton(fixture)).not.toBe(firstRetry);
    expect(document.activeElement).toBe(retryButton(fixture));
  });

  it('shows the spinner, not the entries of an earlier load, during a retry', async () => {
    listOperations.mockResolvedValueOnce([operation('op-1')]);
    listOperations.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    listOperations.mockReturnValueOnce(new Promise(() => undefined));
    const fixture = await render();
    await fixture.componentInstance.detach(resources[0]);
    fixture.detectChanges();

    retryButton(fixture).click();
    fixture.detectChanges();

    expect(card(fixture).querySelector('mat-spinner')).not.toBeNull();
    expect(card(fixture).textContent).not.toContain('op-1');
  });

  it('keeps the entries while reloading after an action', async () => {
    listOperations.mockResolvedValueOnce([operation('op-1')]);
    listOperations.mockReturnValueOnce(new Promise(() => undefined));
    const fixture = await render();

    void fixture.componentInstance.detach(resources[0]);
    await vi.waitFor(() => expect(listOperations).toHaveBeenCalledTimes(2));
    fixture.detectChanges();

    expect(card(fixture).textContent).toContain('op-1');
    expect(card(fixture).querySelector('mat-spinner')).toBeNull();
  });

  it('replaces the entries with the error card when the reload after an action fails', async () => {
    listOperations.mockResolvedValueOnce([operation('op-1')]);
    listOperations.mockRejectedValueOnce({ statusCode: 500, message: 'Database unavailable' });
    const fixture = await render();

    await fixture.componentInstance.detach(resources[0]);
    fixture.detectChanges();

    expect(card(fixture).querySelector('app-load-error')?.textContent).toContain(
      'Database unavailable'
    );
    expect(card(fixture).textContent).not.toContain('op-1');
    expect(openSnackBar).not.toHaveBeenCalled();
  });

  it('shows only the result of the latest load when a Retry overlaps a reload', async () => {
    const stale = deferred<ConfigOperation[]>();
    listOperations.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    listOperations.mockReturnValueOnce(stale.promise);
    listOperations.mockResolvedValueOnce([operation('op-1')]);
    const fixture = await render();
    const component = fixture.componentInstance;

    // The reload after a detach is still running when the user retries.
    const detaching = component.detach(resources[0]);
    await vi.waitFor(() => expect(listOperations).toHaveBeenCalledTimes(2));
    await component.retryOperations();
    stale.reject(new TypeError('Failed to fetch'));
    await detaching;
    fixture.detectChanges();

    expect(component.operationsLoadError).toBe('');
    expect(card(fixture).textContent).toContain('op-1');
  });

  it('keeps the entries of a Retry when an older reload succeeds after it', async () => {
    const older = deferred<ConfigOperation[]>();
    listOperations.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    listOperations.mockReturnValueOnce(older.promise);
    listOperations.mockResolvedValueOnce([operation('op-1')]);
    const fixture = await render();
    const component = fixture.componentInstance;

    const detaching = component.detach(resources[0]);
    await vi.waitFor(() => expect(listOperations).toHaveBeenCalledTimes(2));
    await component.retryOperations();
    older.resolve([operation('outdated')]);
    await detaching;
    fixture.detectChanges();

    expect(card(fixture).textContent).toContain('op-1');
    expect(card(fixture).textContent).not.toContain('outdated');
  });

  it('keeps the spinner of a pending Retry when an older reload finishes first', async () => {
    const older = deferred<ConfigOperation[]>();
    listOperations.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    listOperations.mockReturnValueOnce(older.promise);
    listOperations.mockReturnValueOnce(new Promise(() => undefined));
    const fixture = await render();
    const component = fixture.componentInstance;

    const detaching = component.detach(resources[0]);
    await vi.waitFor(() => expect(listOperations).toHaveBeenCalledTimes(2));
    void component.retryOperations();
    older.resolve([]);
    await detaching;
    fixture.detectChanges();

    expect(card(fixture).querySelector('mat-spinner')).not.toBeNull();
    expect(card(fixture).textContent).not.toContain(emptyText);
  });

  it('leaves the focus where the user moved it during the retry', async () => {
    listOperations.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const reload = deferred<ConfigOperation[]>();
    listOperations.mockReturnValueOnce(reload.promise);
    const fixture = await render();
    retryButton(fixture).focus();

    retryButton(fixture).click();
    fixture.detectChanges();
    const refreshButton = [...card(fixture).querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Refresh history')
    )!;
    refreshButton.focus();
    reload.resolve([operation('op-1')]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(document.activeElement).toBe(refreshButton);
  });
});

describe('ConfigPortabilityComponent resource filters', () => {
  const row = (kind: string, resourceId: string, ownership: string, source?: string) =>
    ({ kind, resourceId, ownership, source, generation: 1 }) as unknown as ConfigResourceMetadata;
  const resources = [
    row('CredentialConfig', 'pid', 'file-managed', 'folder:/app/config/demo'),
    row('CredentialConfig', 'mdl', 'unmanaged'),
    row('Client', 'wallet-frontend', 'file-managed', 'bundle:staging'),
    row('Client', 'admin', 'detached', 'folder:/app/config/demo'),
    row('TrustList', 'eu-pid', 'file-managed', 'folder:/app/config/demo'),
  ];

  let component: ConfigPortabilityComponent;

  const shown = () => component.shownResources.map((resource) => component.resourceKey(resource));

  beforeEach(() => {
    component = new ConfigPortabilityComponent(
      {} as unknown as ConfigPortabilityService,
      {} as unknown as MatSnackBar,
      { hasRole: () => true } as unknown as JwtService
    );
    component.resources = resources;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers each listed kind once, sorted, with its number of resources', () => {
    expect(component.kindOptions).toEqual([
      { value: 'Client', count: 2 },
      { value: 'CredentialConfig', count: 2 },
      { value: 'TrustList', count: 1 },
    ]);
    expect(component.ownershipOptions).toEqual([
      { value: 'file-managed', count: 3 },
      { value: 'detached', count: 1 },
      { value: 'unmanaged', count: 1 },
    ]);
  });

  it('counts the rows each option shows with the other filters applied', () => {
    component.ownershipFilter = ['file-managed'];
    component.kindFilter = ['CredentialConfig'];
    component.applyFilters();

    expect(component.kindOptions).toEqual([
      { value: 'Client', count: 1 },
      { value: 'CredentialConfig', count: 1 },
      { value: 'TrustList', count: 1 },
    ]);
    expect(component.ownershipOptions).toEqual([
      { value: 'file-managed', count: 1 },
      { value: 'detached', count: 0 },
      { value: 'unmanaged', count: 1 },
    ]);
  });

  it('shows all resources without filters', () => {
    expect(component.shownResources).toEqual(resources);
    expect(component.hasActiveFilters).toBe(false);
  });

  it('shows the resources of the chosen kinds and ownership states', () => {
    component.kindFilter = ['CredentialConfig', 'Client'];
    component.applyFilters();
    expect(shown()).toEqual([
      'CredentialConfig/pid',
      'CredentialConfig/mdl',
      'Client/wallet-frontend',
      'Client/admin',
    ]);

    component.ownershipFilter = ['file-managed'];
    component.applyFilters();
    expect(shown()).toEqual(['CredentialConfig/pid', 'Client/wallet-frontend']);
  });

  it('searches the resource ID and the source, ignoring case', () => {
    component.search = '  PID ';
    component.applyFilters();
    expect(shown()).toEqual(['CredentialConfig/pid', 'TrustList/eu-pid']);

    component.search = 'staging';
    component.applyFilters();
    expect(shown()).toEqual(['Client/wallet-frontend']);
  });

  it('searches the Resource and Source columns as they read', () => {
    component.search = 'client/admin';
    component.applyFilters();
    expect(shown()).toEqual(['Client/admin']);

    component.search = 'API / UI';
    component.applyFilters();
    expect(shown()).toEqual(['CredentialConfig/mdl']);
  });

  it('clears all filters', () => {
    component.kindFilter = ['TrustList'];
    component.ownershipFilter = ['detached'];
    component.search = 'x';
    component.applyFilters();
    expect(component.shownResources).toEqual([]);

    component.clearFilters();

    expect(component.shownResources).toEqual(resources);
    expect(component.hasActiveFilters).toBe(false);
  });

  it('selects all only the file-managed resources in view', () => {
    component.kindFilter = ['Client'];
    component.applyFilters();

    component.selectAll();

    expect([...component.selected]).toEqual(['Client/wallet-frontend']);
    expect(component.allSelected).toBe(true);
  });

  it('drops the selection of the rows a filter hides', () => {
    component.selectAll();
    expect(component.selected.size).toBe(3);

    component.kindFilter = ['CredentialConfig'];
    component.applyFilters();

    expect([...component.selected]).toEqual(['CredentialConfig/pid']);
  });

  it('drops the selection of resources a refresh no longer lists', () => {
    component.selectResource(resources[0]);
    component.selectResource(resources[2]);

    component.resources = resources.filter((resource) => resource.resourceId !== 'pid');

    expect([...component.selected]).toEqual(['Client/wallet-frontend']);
  });

  it('names the resources in the question before detaching them', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    component.kindFilter = ['Client'];
    component.applyFilters();
    component.selectAll();

    await component.detachSelected();

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('Detach 1 resource(s): Client/wallet-frontend?')
    );
  });

  it('does not count a search of only spaces as a filter', () => {
    component.search = '   ';
    component.applyFilters();

    expect(component.hasActiveFilters).toBe(false);
    expect(component.resourceSummary).toBe('5 resources');
    expect(component.shownResources).toEqual(resources);
  });

  it('says "1 resource" for a single resource', () => {
    component.resources = [resources[0]];
    expect(component.resourceSummary).toBe('1 resource');

    component.kindFilter = ['Client'];
    component.applyFilters();
    expect(component.resourceSummary).toBe('Showing 0 of 1 resource');
  });

  it('keeps a chosen kind as an option after its last resource is gone', () => {
    component.kindFilter = ['TrustList'];
    component.applyFilters();

    component.resources = resources.filter((resource) => resource.kind !== 'TrustList');

    expect(component.kindOptions).toContainEqual({ value: 'TrustList', count: 0 });
    expect(component.shownResources).toEqual([]);
  });

  it('says how many resources the filters show, and when none match', async () => {
    TestBed.configureTestingModule({
      imports: [ConfigPortabilityComponent],
      providers: [
        provideRouter([]),
        {
          provide: ConfigPortabilityService,
          useValue: {
            listResources: vi.fn(async () => resources),
            listOperations: vi.fn(async () => []),
          },
        },
        { provide: JwtService, useValue: { hasRole: () => true } },
      ],
    });
    const fixture = TestBed.createComponent(ConfigPortabilityComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const status = () => element.querySelector('output')?.textContent?.trim();
    expect(status()).toBe('5 resources');

    const input = element.querySelector<HTMLInputElement>(
      'input[placeholder="Resource ID or source"]'
    )!;
    input.value = 'pid';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(status()).toBe('Showing 2 of 5 resources');
    element.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(status()).toBe('5 resources');
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);

    fixture.componentInstance.kindFilter = ['Client'];
    fixture.componentInstance.applyFilters();
    fixture.detectChanges();
    expect(status()).toBe('Showing 2 of 5 resources');
    expect(element.textContent).toContain('Clear Filters');

    fixture.componentInstance.search = 'no such resource';
    fixture.componentInstance.applyFilters();
    fixture.detectChanges();
    expect(status()).toBe('Showing 0 of 5 resources');
    expect(element.textContent).toContain('No resources match the filters.');

    const clearFilters = [...element.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Clear Filters')
    )!;
    clearFilters.click();
    fixture.detectChanges();
    expect(status()).toBe('5 resources');
    expect(document.activeElement).toBe(input);
  });
});

describe('ConfigPortabilityComponent select all without file-managed rows in view', () => {
  it('keeps the checkbox focusable and does not select anything', async () => {
    TestBed.configureTestingModule({
      imports: [ConfigPortabilityComponent],
      providers: [
        provideRouter([]),
        {
          provide: ConfigPortabilityService,
          useValue: {
            listResources: vi.fn(async () => [
              { kind: 'Client', resourceId: 'admin', ownership: 'unmanaged', generation: 1 },
            ]),
            listOperations: vi.fn(async () => []),
          },
        },
        { provide: JwtService, useValue: { hasRole: () => true } },
      ],
    });
    const fixture = TestBed.createComponent(ConfigPortabilityComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      'input[aria-label="Select all detachable resources in view"]'
    )!;

    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-disabled')).toBe('true');
    input.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.selected.size).toBe(0);
  });
});

describe('ConfigPortabilityComponent resource filters after a failed reload', () => {
  it('shows no rows but keeps the selection', async () => {
    const listResources = vi.fn();
    const component = new ConfigPortabilityComponent(
      {
        listResources,
        listOperations: vi.fn(async () => []),
      } as unknown as ConfigPortabilityService,
      { open: vi.fn() } as unknown as MatSnackBar,
      { hasRole: () => false } as unknown as JwtService
    );
    component.resources = [
      { kind: 'Client', resourceId: 'admin', ownership: 'file-managed', generation: 1 },
    ] as unknown as ConfigResourceMetadata[];
    component.selectAll();
    listResources.mockRejectedValue(new TypeError('Failed to fetch'));

    await component.retryResources();

    expect(component.shownResources).toEqual([]);
    expect(component.kindOptions).toEqual([]);
    expect([...component.selected]).toEqual(['Client/admin']);
  });
});
