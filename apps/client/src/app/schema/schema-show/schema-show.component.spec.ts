import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { EMPTY, Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialConfigService } from '../../issuance/credential-config/credential-config.service';
import { JwtService } from '../../services/jwt.service';
import { SchemaService } from '../schema.service';
import { SchemaShowComponent } from './schema-show.component';
import { errorSnackBarDuration } from '../../utils/error-snackbar';

/** The arguments of an error snackbar with this text. */
const errorSnackBar = (text: string) =>
  [text, 'Close', { duration: errorSnackBarDuration(text) }] as const;

const catalogId = 'https://registrar.example/schema-metadata/schema-1';

const vocabularies = {
  version: '1',
  categories: [{ code: 'identity', label: 'Identity', status: 'active' }],
  tags: [
    { code: 'pid', label: 'PID', status: 'active' },
    { code: 'eudi', label: 'EUDI', status: 'active' },
  ],
};

/** A JwtService stub that grants the given roles. */
function jwtWithRoles(...roles: string[]) {
  return { hasRole: (role: string | string[]) => [role].flat().some((r) => roles.includes(r)) };
}

function currentVersion(overrides: Record<string, unknown> = {}) {
  const payload = btoa(JSON.stringify({ id: catalogId }));
  return {
    id: 'schema-1',
    version: '1.0.0',
    displayName: 'German PID',
    rulebookURI: 'https://rules.example/pid.md',
    attestationLoS: 'iso_18045_high',
    bindingType: 'key',
    category: 'identity',
    // The registrar returns tags as free-form strings.
    tags: ['pid', 'legacy-tag', 'eudi'],
    schemaURIs: [
      {
        id: 'schema-uri-1',
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://eudiplo.example/issuers/acme/schema/pid/dc+sd-jwt',
      },
    ],
    trustedAuthorities: [
      {
        id: 'authority-1',
        frameworkType: 'etsi_tl',
        value: 'https://eudiplo.example/issuers/acme/trust-list/tl-1',
      },
    ],
    signedJwt: `eyJhbGciOiJFUzI1NiJ9.${payload}.signature`,
    ...overrides,
  };
}

describe('SchemaShowComponent publishing a new version', () => {
  let component: SchemaShowComponent;
  let schemaService: Record<string, ReturnType<typeof vi.fn>>;
  let credentialConfigs: unknown[];
  let loadConfigurations: ReturnType<typeof vi.fn>;
  let openSnackBar: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;

  async function load(item = currentVersion()) {
    schemaService['getById'].mockResolvedValue(item);
    component.id = 'schema-1';
    await component.load();
  }

  function publishedConfig() {
    expect(schemaService['publishSchemaMetadataVersion']).toHaveBeenCalledOnce();
    return schemaService['publishSchemaMetadataVersion'].mock.calls[0][0];
  }

  beforeEach(() => {
    schemaService = {
      getById: vi.fn(),
      getVersions: vi.fn().mockResolvedValue([{ version: '1.0.0' }]),
      getVocabularies: vi.fn().mockResolvedValue(vocabularies),
      list: vi.fn(),
      publishSchemaMetadataVersion: vi.fn().mockResolvedValue({ id: 'schema-1', version: '1.1.0' }),
      deprecateVersion: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    credentialConfigs = [{ id: 'pid', vct: 'urn:eudi:pid:1', config: { format: 'dc+sd-jwt' } }];
    loadConfigurations = vi.fn(async () => credentialConfigs);
    openSnackBar = vi.fn().mockReturnValue({ onAction: () => EMPTY });
    navigate = vi.fn().mockResolvedValue(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate } },
        { provide: ActivatedRoute, useValue: {} },
        { provide: SchemaService, useValue: schemaService },
        { provide: CredentialConfigService, useValue: { loadConfigurations } },
        { provide: MatSnackBar, useValue: { open: openSnackBar } },
        { provide: JwtService, useValue: jwtWithRoles('registrar:manage', 'issuance:manage') },
      ],
    });
    component = TestBed.runInInjectionContext(() => new SchemaShowComponent());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the display name, category and tags of the current version', async () => {
    await load();

    await component.publishNewVersion();

    const config = publishedConfig();
    expect(config).toMatchObject({
      id: catalogId,
      name: 'German PID',
      version: '1.1.0',
      rulebookURI: 'https://rules.example/pid.md',
      category: 'identity',
      tags: ['pid', 'eudi'],
    });
    expect(schemaService['deprecateVersion']).toHaveBeenCalledWith('schema-1', '1.0.0', {
      deprecated: true,
      message: 'Superseded by version 1.1.0',
      supersededByVersion: '1.1.0',
    });
    expect(navigate).toHaveBeenCalledWith(['/schema', 'schema-1'], {
      queryParams: { version: '1.1.0' },
    });
  });

  it('reports tags outside the vocabulary that it leaves out', async () => {
    await load();

    await component.publishNewVersion();

    const [message, , options] = openSnackBar.mock.calls[0];
    expect(message).toContain('Version 1.1.0 published successfully.');
    expect(message).toContain('not carried over: legacy-tag');
    expect(options).toEqual({ duration: 10000 });
  });

  it('leaves out and reports a category outside the vocabulary', async () => {
    await load(currentVersion({ category: 'health' }));

    expect(component.classificationNote).toContain('not carried over: health, legacy-tag.');
    await component.publishNewVersion();

    expect(publishedConfig()).not.toHaveProperty('category');
    expect(openSnackBar.mock.calls[0][0]).toContain('not carried over: health, legacy-tag');
  });

  it('neither deprecates nor navigates when the publish is rejected', async () => {
    schemaService['publishSchemaMetadataVersion'].mockRejectedValue({
      statusCode: 400,
      message: 'Validation failed',
      errors: [{ path: ['config', 'tags', 0], message: 'Invalid option', code: 'invalid_value' }],
    });
    await load();

    await component.publishNewVersion();

    expect(schemaService['deprecateVersion']).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Failed to publish new version: Validation failed (config.tags.0: Invalid option)'
      )
    );
    expect(component.publishing).toBe(false);
  });

  it('keeps the current version when "Deprecate current version" is unticked', async () => {
    await load(currentVersion({ tags: ['pid'] }));
    component.publishForm.controls.deprecateCurrent.setValue(false);

    await component.publishNewVersion();

    expect(schemaService['deprecateVersion']).not.toHaveBeenCalled();
    expect(openSnackBar).toHaveBeenCalledWith('Version 1.1.0 published successfully.', 'Close', {
      duration: 4000,
    });
  });

  it('names the rejected field when saving catalog metadata fails', async () => {
    schemaService['updateMetadata'] = vi.fn().mockRejectedValue({
      statusCode: 400,
      message: 'Validation failed',
      errors: [{ path: ['category'], message: 'Invalid option', code: 'invalid_value' }],
    });
    await load();

    await component.saveMetadata();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar('Failed to update metadata: Validation failed (category: Invalid option)')
    );
  });

  it('saves only the catalog metadata fields that were changed', async () => {
    schemaService['updateMetadata'] = vi.fn().mockResolvedValue(currentVersion());
    await load();

    component.metadataForm.controls.displayName.setValue('Renamed PID');
    component.metadataForm.controls.displayName.markAsDirty();
    await component.saveMetadata();

    // legacy-tag has no option in the tag select, so sending the tags back would fail with 400.
    expect(schemaService['updateMetadata']).toHaveBeenCalledWith('schema-1', '1.0.0', {
      displayName: 'Renamed PID',
    });
  });

  it('treats the catalog metadata form as unchanged after loading a version', async () => {
    await load();
    component.metadataForm.markAsDirty();

    await load();

    expect(component.metadataForm.dirty).toBe(false);
  });

  it('carries over deprecated vocabulary codes, which stay valid', async () => {
    schemaService['getVocabularies'].mockResolvedValue({
      version: '1',
      categories: [{ code: 'identity', label: 'Identity', status: 'deprecated' }],
      tags: [
        { code: 'pid', label: 'PID', status: 'active' },
        { code: 'eudi', label: 'EUDI', status: 'deprecated', replacedBy: 'pid' },
      ],
    });
    await load();

    await component.publishNewVersion();

    expect(publishedConfig()).toMatchObject({ category: 'identity', tags: ['pid', 'eudi'] });
  });

  it('sends no category or tags when the current version has none', async () => {
    await load(currentVersion({ category: undefined, tags: undefined }));

    await component.publishNewVersion();

    const config = publishedConfig();
    expect(config).not.toHaveProperty('category');
    expect(config).not.toHaveProperty('tags');
    expect(openSnackBar).toHaveBeenCalledWith('Version 1.1.0 published successfully.', 'Close', {
      duration: 4000,
    });
  });

  it('uses the ID as name when the current version has no display name', async () => {
    await load(currentVersion({ displayName: undefined }));

    await component.publishNewVersion();

    expect(publishedConfig().name).toBe('schema-1');
  });

  it('says before publishing that a schema URI cannot be rebuilt', async () => {
    credentialConfigs = [];
    await load();

    expect(component.publishBlockedReason).toBe(
      'Publishing needs exactly one credential config of format dc+sd-jwt linked to this ' +
        'schema, to rebuild its schema URI.'
    );
    await component.publishNewVersion();

    expect(schemaService['publishSchemaMetadataVersion']).not.toHaveBeenCalled();
    expect(component.publishing).toBe(false);
  });

  it('rebuilds a schema URI the registrar stored under a random name from the linked config', async () => {
    // The registrar renames uploads, so the URI does not name the credential config.
    credentialConfigs = [
      {
        id: 'pid',
        vct: 'urn:eudi:pid:1',
        config: { format: 'dc+sd-jwt' },
        schemaMeta: { id: catalogId },
      },
      { id: 'mdl', config: { format: 'mso_mdoc', docType: 'org.iso.18013.5.1.mDL' } },
    ];
    await load(
      currentVersion({
        schemaURIs: [
          {
            id: 'schema-uri-1',
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://registrar.example/schemas/assets/schemas/w12xYzABcdEfgH1I.json',
          },
        ],
      })
    );

    await component.publishNewVersion();

    expect(publishedConfig().schemaURIs).toEqual([
      {
        format: 'dc+sd-jwt',
        uri: 'https://registrar.example/schemas/assets/schemas/w12xYzABcdEfgH1I.json',
        meta: { vct: 'urn:eudi:pid:1' },
      },
    ]);
  });

  it('does not guess between several linked configs of the same format', async () => {
    credentialConfigs = ['pid', 'pid-2'].map((id) => ({
      id,
      vct: `urn:eudi:${id}`,
      config: { format: 'dc+sd-jwt' },
      schemaMeta: { id: catalogId },
    }));
    await load(
      currentVersion({
        schemaURIs: [
          {
            id: 'schema-uri-1',
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://registrar.example/schemas/assets/schemas/w12xYzABcdEfgH1I.json',
          },
        ],
      })
    );

    expect(component.publishBlockedReason).toContain(
      'needs exactly one credential config of format dc+sd-jwt'
    );
    await component.publishNewVersion();

    expect(schemaService['publishSchemaMetadataVersion']).not.toHaveBeenCalled();
  });

  it('proposes the version after the newest one, not after the shown one', async () => {
    schemaService['getVersions'].mockResolvedValue([
      { version: '1.0.0' },
      { version: '1.1.0' },
      { version: '1.2.0-rc.1' },
    ]);
    await load();

    expect(component.publishForm.controls.newVersion.value).toBe('1.2.0');
    component.publishForm.controls.newVersion.setValue('1.1.0');
    expect(component.publishForm.controls.newVersion.hasError('taken')).toBe(true);
  });

  it('saves catalog metadata once while a save is running', async () => {
    let finish!: (entry: unknown) => void;
    schemaService['updateMetadata'] = vi
      .fn()
      .mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await load();
    component.metadataForm.controls.displayName.setValue('Renamed PID');
    component.metadataForm.controls.displayName.markAsDirty();

    const first = component.saveMetadata();
    await component.saveMetadata();
    finish(currentVersion({ displayName: 'Renamed PID' }));
    await first;

    expect(schemaService['updateMetadata']).toHaveBeenCalledOnce();
    expect(component.saving).toBe(false);
    expect(component.metadataForm.pristine).toBe(true);
  });

  it('keeps a version opened while its predecessor was being saved', async () => {
    let finish!: (entry: unknown) => void;
    schemaService['updateMetadata'] = vi
      .fn()
      .mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await load();
    component.metadataForm.controls.displayName.markAsDirty();

    const saving = component.saveMetadata();
    const other = currentVersion({ version: '1.2.0' });
    component.item = other as typeof component.item;
    finish(currentVersion({ displayName: 'Renamed PID' }));
    await saving;

    expect(component.item).toBe(other);
    expect(openSnackBar).toHaveBeenCalledWith('Metadata of version 1.0.0 updated', 'Close', {
      duration: 3000,
    });
  });

  it('reports a failed deprecation as such, not as a failed publish', async () => {
    schemaService['deprecateVersion'].mockRejectedValue({
      statusCode: 403,
      message: 'Forbidden resource',
    });
    await load();

    await component.publishNewVersion();

    const [message] = openSnackBar.mock.calls[0];
    expect(message).toContain('Version 1.1.0 published successfully.');
    expect(message).toContain('Failed to deprecate version 1.0.0: Forbidden resource.');
    expect(navigate).toHaveBeenCalledWith(['/schema', 'schema-1'], {
      queryParams: { version: '1.1.0' },
    });
  });

  it('offers to retry a failed deprecation from the snackbar', async () => {
    const retry = new Subject<void>();
    openSnackBar.mockReturnValueOnce({ onAction: () => retry });
    schemaService['deprecateVersion'].mockRejectedValueOnce({
      statusCode: 502,
      message: 'Registrar unreachable',
    });
    await load();

    await component.publishNewVersion();
    expect(openSnackBar.mock.calls[0][1]).toBe('Retry');

    retry.next();
    await vi.waitFor(() =>
      expect(openSnackBar).toHaveBeenLastCalledWith('Version 1.0.0 deprecated.', 'Close', {
        duration: 4000,
      })
    );
    expect(schemaService['deprecateVersion']).toHaveBeenCalledTimes(2);
    expect(schemaService['deprecateVersion']).toHaveBeenLastCalledWith('schema-1', '1.0.0', {
      deprecated: true,
      message: 'Superseded by version 1.1.0',
      supersededByVersion: '1.1.0',
    });
  });

  it('offers Retry again when the retried deprecation fails too', async () => {
    const retry = new Subject<void>();
    openSnackBar.mockReturnValueOnce({ onAction: () => retry });
    schemaService['deprecateVersion'].mockRejectedValue({ statusCode: 403, message: 'Forbidden' });
    await load();

    await component.publishNewVersion();
    retry.next();

    await vi.waitFor(() =>
      expect(openSnackBar).toHaveBeenLastCalledWith(
        'Failed to deprecate version 1.0.0: Forbidden. ' +
          'Retry now, or later with Deprecate on version 1.0.0.',
        'Retry',
        { duration: 15000 }
      )
    );
  });
});

describe('SchemaShowComponent loading', () => {
  let component: SchemaShowComponent;
  let schemaService: Record<string, ReturnType<typeof vi.fn>>;
  let loadConfigurations: ReturnType<typeof vi.fn>;
  let openSnackBar: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;

  function create(roles = ['registrar:manage', 'issuance:manage']) {
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate } },
        { provide: ActivatedRoute, useValue: {} },
        { provide: SchemaService, useValue: schemaService },
        { provide: CredentialConfigService, useValue: { loadConfigurations } },
        { provide: MatSnackBar, useValue: { open: openSnackBar } },
        { provide: JwtService, useValue: jwtWithRoles(...roles) },
      ],
    });
    component = TestBed.runInInjectionContext(() => new SchemaShowComponent());
    component.id = 'schema-1';
    return component;
  }

  beforeEach(() => {
    schemaService = {
      getById: vi.fn().mockResolvedValue(currentVersion()),
      getVersions: vi.fn().mockResolvedValue([{ version: '1.0.0' }]),
      getVocabularies: vi.fn().mockResolvedValue(vocabularies),
      list: vi.fn(),
      publishSchemaMetadataVersion: vi.fn().mockResolvedValue({ id: 'schema-1', version: '1.1.0' }),
      deprecateVersion: vi.fn().mockResolvedValue({}),
    };
    loadConfigurations = vi
      .fn()
      .mockResolvedValue([{ id: 'pid', vct: 'urn:eudi:pid:1', config: { format: 'dc+sd-jwt' } }]);
    openSnackBar = vi.fn().mockReturnValue({ onAction: () => EMPTY });
    navigate = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reloads only the sources that failed', async () => {
    schemaService['getVocabularies'].mockRejectedValueOnce({
      statusCode: 502,
      message: 'Bad Gateway',
    });
    create();
    await component.load();

    await component.retrySources();

    expect(schemaService['getVocabularies']).toHaveBeenCalledTimes(2);
    expect(loadConfigurations).toHaveBeenCalledOnce();
  });

  it('says that credential configs may reference a schema whose only version is deleted', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    create(['registrar:manage']);
    await component.load();

    await component.delete();

    expect(confirmSpy).toHaveBeenCalledWith(
      'Delete version 1.0.0 of schema "German PID" at the registrar? It is the only version; ' +
        'credential configs may still reference the schema. This cannot be undone.'
    );
  });

  it('names the referencing credential configs before deleting the only version', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    create();
    await component.load();

    await component.delete();

    expect(confirmSpy).toHaveBeenCalledWith(
      'Delete version 1.0.0 of schema "German PID" at the registrar? It is the only version, ' +
        'and these credential configs still reference the schema: pid. This cannot be undone.'
    );
  });

  it('shows the schema when the registrar vocabularies fail, with Category and Tags disabled', async () => {
    schemaService['getVocabularies'].mockRejectedValue({
      statusCode: 502,
      message: 'Registrar unreachable',
    });
    create();

    await component.load();

    expect(component.item?.id).toBe('schema-1');
    expect(component.loadError).toBe('');
    expect(navigate).not.toHaveBeenCalled();
    expect(component.metadataForm.controls.category.disabled).toBe(true);
    expect(component.metadataForm.controls.tags.disabled).toBe(true);
    expect(component.metadataForm.controls.displayName.enabled).toBe(true);
    expect(component.relatedCredentialConfigs.map((c) => c.id)).toEqual(['pid']);
    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar('Failed to load the registrar vocabulary: Registrar unreachable')
    );
  });

  it('names both sources in one message when the backend does not answer them', async () => {
    schemaService['getVocabularies'].mockRejectedValue(new TypeError('Failed to fetch'));
    loadConfigurations.mockRejectedValue(new TypeError('Failed to fetch'));
    create();

    await component.load();

    expect(component.item?.id).toBe('schema-1');
    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar(
        'Failed to load credential configs and the registrar vocabulary: ' +
          'the backend could not be reached. Check the connection and try again.'
      )
    );
  });

  it('carries category and tags over unchecked when the vocabularies are missing, and says so', async () => {
    schemaService['getVocabularies'].mockRejectedValue(new TypeError('Failed to fetch'));
    create();
    await component.load();

    expect(component.classificationNote).toBe(
      'The category and tags could not be checked against the registrar vocabulary and are ' +
        'carried over unchecked: identity, pid, legacy-tag, eudi.'
    );
    expect(component.publishBlockedReason).toBe('');
    await component.publishNewVersion();

    expect(schemaService['publishSchemaMetadataVersion'].mock.calls[0][0]).toMatchObject({
      category: 'identity',
      tags: ['pid', 'legacy-tag', 'eudi'],
    });
  });

  it('enables Category and Tags once the vocabularies are loaded', async () => {
    create();

    await component.load();

    expect(component.loadState.vocabularies).toBe('loaded');
    expect(component.metadataForm.controls.category.enabled).toBe(true);
    expect(component.metadataForm.controls.tags.enabled).toBe(true);
    expect(openSnackBar).not.toHaveBeenCalled();
  });

  it('shows the schema when the credential configs fail, and blocks only publishing', async () => {
    loadConfigurations.mockRejectedValue({ statusCode: 500, message: 'Internal server error' });
    create();

    await component.load();

    expect(component.item?.id).toBe('schema-1');
    expect(component.loadState.credentialConfigs).toBe('failed');
    expect(component.publishBlockedReason).toBe(
      'Publishing needs the credential configs, which could not be loaded.'
    );
    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar('Failed to load credential configs: Internal server error')
    );

    openSnackBar.mockClear();
    await component.publishNewVersion();
    expect(schemaService['publishSchemaMetadataVersion']).not.toHaveBeenCalled();
    // Blocked before building the request, not failed while building it.
    expect(openSnackBar).not.toHaveBeenCalled();
  });

  it('shows why the schema could not be loaded instead of leaving the page', async () => {
    schemaService['getById'].mockRejectedValue({
      statusCode: 404,
      message: 'Schema metadata not found',
    });
    schemaService['getVocabularies'].mockRejectedValue({ statusCode: 502, message: 'Bad Gateway' });
    create();

    await component.load('2.0.0');

    expect(component.item).toBeUndefined();
    expect(component.loadError).toBe('Failed to load schema: Schema metadata not found');
    expect(navigate).not.toHaveBeenCalled();
    // The failures of the other sources are not reported on top.
    expect(openSnackBar).not.toHaveBeenCalled();

    schemaService['getById'].mockResolvedValue(currentVersion());
    schemaService['getVocabularies'].mockResolvedValue(vocabularies);
    schemaService['list'].mockResolvedValue([currentVersion({ version: '2.0.0' })]);
    component.retryLoad();
    await vi.waitFor(() => expect(component.item?.version).toBe('2.0.0'));
    expect(component.loadError).toBe('');
  });

  it('blocks Publish while the credential configs are still loading', async () => {
    loadConfigurations.mockReturnValue(new Promise(() => undefined));
    create();

    const loading = component.load();
    await vi.waitFor(() => expect(component.item).toBeDefined());

    expect(component.publishBlockedReason).toBe(
      'Loading credential configs and the registrar vocabulary…'
    );
    await component.publishNewVersion();
    expect(schemaService['publishSchemaMetadataVersion']).not.toHaveBeenCalled();
    expect(openSnackBar).not.toHaveBeenCalled();
    void loading;
  });

  it('blocks Publish while only the vocabulary is still loading', async () => {
    schemaService['getVocabularies'].mockReturnValue(new Promise(() => undefined));
    create();

    void component.load();
    await vi.waitFor(() => expect(component.loadState.credentialConfigs).toBe('loaded'));

    expect(component.publishBlockedReason).toBe(
      'Loading credential configs and the registrar vocabulary…'
    );
    await component.publishNewVersion();
    expect(schemaService['publishSchemaMetadataVersion']).not.toHaveBeenCalled();
  });

  it('lists the referencing credential configs before the vocabulary answers', async () => {
    schemaService['getVocabularies'].mockReturnValue(new Promise(() => undefined));
    create();

    void component.load();
    await vi.waitFor(() => expect(component.loadState.credentialConfigs).toBe('loaded'));

    expect(component.relatedCredentialConfigs.map((c) => c.id)).toEqual(['pid']);
  });

  it('loads vocabularies and credential configs once, not on every version switch', async () => {
    schemaService['getVocabularies'].mockRejectedValue({ statusCode: 502, message: 'Bad Gateway' });
    schemaService['list'].mockResolvedValue([currentVersion({ version: '1.1.0' })]);
    create();

    await component.load();
    await component.load('1.1.0');

    expect(schemaService['getVocabularies']).toHaveBeenCalledOnce();
    expect(loadConfigurations).toHaveBeenCalledOnce();
    // The failure is named once, so it does not replace later messages such as a publish result.
    expect(
      openSnackBar.mock.calls.filter(([message]) => String(message).includes('Bad Gateway'))
    ).toHaveLength(1);
  });

  it('reloads failed sources on Retry', async () => {
    schemaService['getVocabularies'].mockRejectedValueOnce({
      statusCode: 502,
      message: 'Bad Gateway',
    });
    loadConfigurations.mockRejectedValueOnce({ statusCode: 500, message: 'Internal server error' });
    create();
    await component.load();
    expect(component.publishBlockedReason).toContain('could not be loaded');

    await component.retrySources();

    expect(component.loadState).toEqual({ vocabularies: 'loaded', credentialConfigs: 'loaded' });
    expect(schemaService['getVocabularies']).toHaveBeenCalledTimes(2);
    expect(loadConfigurations).toHaveBeenCalledTimes(2);
    expect(component.metadataForm.controls.category.enabled).toBe(true);
    expect(component.relatedCredentialConfigs.map((c) => c.id)).toEqual(['pid']);
    expect(component.publishBlockedReason).toBe('');
  });

  it('shows the version opened last when an earlier load answers later', async () => {
    let answerFirst!: (items: unknown[]) => void;
    schemaService['list']
      .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce([currentVersion({ version: '1.2.0' })]);
    create();

    const first = component.load('1.1.0');
    await component.load('1.2.0');
    answerFirst([currentVersion({ version: '1.1.0' })]);
    await first;

    expect(component.item?.version).toBe('1.2.0');
    expect(component.loading).toBe(false);
  });

  it('sorts versions by SemVer precedence, a pre-release below its release', async () => {
    schemaService['getVersions'].mockResolvedValue([
      { version: '1.1.0-rc.1' },
      { version: '1.0.0' },
      { version: '1.10.0' },
      { version: '1.1.0' },
      { version: '1.2.0' },
    ]);
    create();

    await component.load();

    expect(component.availableVersions).toEqual([
      '1.10.0',
      '1.2.0',
      '1.1.0',
      '1.1.0-rc.1',
      '1.0.0',
    ]);
  });

  it('names the reason when copying or downloading the signed JWT fails', async () => {
    schemaService['getSignedJwt'] = vi
      .fn()
      .mockRejectedValue({ statusCode: 404, message: 'Not Found' });
    create();
    await component.load();

    await component.copyJwt();
    await component.downloadExport();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar('Failed to load the signed JWT: Not Found')
    );
    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar('Failed to download JWT: Not Found')
    );
  });

  it('says how to get the signed JWT when it loads but cannot be copied', async () => {
    schemaService['getSignedJwt'] = vi.fn().mockResolvedValue('ey.signed.jwt');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    create();
    await component.load();

    try {
      await component.copyJwt();
    } finally {
      delete (navigator as { clipboard?: Clipboard }).clipboard;
    }

    expect(openSnackBar).toHaveBeenCalledOnce();
    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar('Could not copy the signed JWT. Use Download export to save it instead.')
    );
  });

  it('neither lists credential configs nor opens Publish without issuance:manage', async () => {
    create(['registrar:manage']);

    await component.load();

    expect(component.canManageIssuance).toBe(false);
    expect(loadConfigurations).not.toHaveBeenCalled();
    expect(openSnackBar).not.toHaveBeenCalled();
    expect(component.publishBlockedReason).toBe(
      'Publishing a new version needs the issuance:manage role.'
    );
    component.togglePublishForm();
    expect(component.showPublishForm).toBe(false);
  });
});

describe('SchemaShowComponent deleting and deprecating', () => {
  let component: SchemaShowComponent;
  let schemaService: Record<string, ReturnType<typeof vi.fn>>;
  let openSnackBar: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    schemaService = {
      getById: vi.fn().mockResolvedValue(currentVersion()),
      getVersions: vi
        .fn()
        .mockResolvedValue([{ version: '1.0.0' }, { version: '1.2.0' }, { version: '1.1.0' }]),
      getVocabularies: vi.fn().mockResolvedValue(vocabularies),
      delete: vi.fn().mockResolvedValue(undefined),
      deprecateVersion: vi
        .fn()
        .mockResolvedValue(currentVersion({ deprecated: true, supersededByVersion: '1.2.0' })),
    };
    openSnackBar = vi.fn().mockReturnValue({ onAction: () => EMPTY });
    navigate = vi.fn().mockResolvedValue(true);
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate } },
        { provide: ActivatedRoute, useValue: {} },
        { provide: SchemaService, useValue: schemaService },
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => [] } },
        { provide: MatSnackBar, useValue: { open: openSnackBar } },
        { provide: JwtService, useValue: jwtWithRoles('registrar:manage') },
      ],
    });
    component = TestBed.runInInjectionContext(() => new SchemaShowComponent());
    component.id = 'schema-1';
    await component.load();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks before deleting and names the schema and version', async () => {
    await component.delete();

    expect(confirmSpy).toHaveBeenCalledWith(
      'Delete version 1.0.0 of schema "German PID" at the registrar? This cannot be undone.'
    );
    expect(component.deleting).toBe(false);
    expect(schemaService['delete']).toHaveBeenCalledWith('schema-1', '1.0.0');
    expect(navigate).toHaveBeenCalledWith(['/schema']);
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    confirmSpy.mockReturnValue(false);

    await component.delete();

    expect(schemaService['delete']).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('names the reason when deleting fails', async () => {
    schemaService['delete'].mockRejectedValue({ statusCode: 403, message: 'Forbidden resource' });

    await component.delete();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar('Failed to delete version 1.0.0: Forbidden resource')
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('deprecates the shown version as superseded by the newest one', async () => {
    await component.deprecate();

    expect(confirmSpy).toHaveBeenCalledWith(
      'Deprecate version 1.0.0 of schema "German PID" at the registrar? ' +
        'It will be marked as superseded by version 1.2.0. The Web Client cannot undo this.'
    );
    expect(schemaService['deprecateVersion']).toHaveBeenCalledWith('schema-1', '1.0.0', {
      deprecated: true,
      message: 'Superseded by version 1.2.0',
      supersededByVersion: '1.2.0',
    });
    expect(component.item?.deprecated).toBe(true);
    expect(component.deprecating).toBe(false);
  });

  it('deprecates the newest version without naming a successor', async () => {
    schemaService['getById'].mockResolvedValue(currentVersion({ version: '1.2.0' }));
    await component.load();

    await component.deprecate();

    expect(confirmSpy).toHaveBeenCalledWith(
      'Deprecate version 1.2.0 of schema "German PID" at the registrar? ' +
        'It is the newest version, so no version replaces it. The Web Client cannot undo this.'
    );
    expect(schemaService['deprecateVersion']).toHaveBeenCalledWith('schema-1', '1.2.0', {
      deprecated: true,
    });
  });

  it('does not name a pre-release as the successor of its release', async () => {
    schemaService['getById'].mockResolvedValue(currentVersion({ version: '1.1.0' }));
    schemaService['getVersions'].mockResolvedValue([
      { version: '1.0.0' },
      { version: '1.1.0-rc.1' },
      { version: '1.1.0' },
    ]);
    await component.load();

    await component.deprecate();

    expect(schemaService['deprecateVersion']).toHaveBeenCalledWith('schema-1', '1.1.0', {
      deprecated: true,
    });
  });

  it('keeps the newly opened version when a deprecation answers after a switch', async () => {
    let answer!: (entry: unknown) => void;
    schemaService['deprecateVersion'].mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const deprecating = component.deprecate();
    const other = currentVersion({ version: '1.2.0' });
    component.item = other as typeof component.item;
    answer(currentVersion({ deprecated: true }));
    await deprecating;

    expect(component.item).toBe(other);
  });

  it('sends one deprecation while the first is running', async () => {
    let finish!: (entry: unknown) => void;
    schemaService['deprecateVersion'].mockReturnValue(new Promise((resolve) => (finish = resolve)));

    const first = component.deprecate();
    await component.deprecate();
    finish(currentVersion({ deprecated: true }));
    await first;

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(schemaService['deprecateVersion']).toHaveBeenCalledOnce();
  });

  it('sends one delete while the first is running', async () => {
    let finish!: () => void;
    schemaService['delete'].mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));

    const first = component.delete();
    await component.delete();
    finish();
    await first;

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(schemaService['delete']).toHaveBeenCalledOnce();
  });

  it('deprecates nothing when the confirmation is cancelled', async () => {
    confirmSpy.mockReturnValue(false);

    await component.deprecate();

    expect(schemaService['deprecateVersion']).not.toHaveBeenCalled();
  });

  it('names the reason when deprecating fails', async () => {
    schemaService['deprecateVersion'].mockRejectedValue({
      statusCode: 502,
      message: 'Registrar unreachable',
    });

    await component.deprecate();

    expect(openSnackBar).toHaveBeenCalledWith(
      ...errorSnackBar('Failed to deprecate version 1.0.0: Registrar unreachable')
    );
    expect(component.item?.deprecated).toBeUndefined();
  });
});

describe('SchemaShowComponent publish card', () => {
  async function render(item = currentVersion()) {
    const schemaService = {
      getById: vi.fn().mockResolvedValue(item),
      getVersions: vi.fn().mockResolvedValue([{ version: '1.0.0' }]),
      getVocabularies: vi.fn().mockResolvedValue(vocabularies),
      updateMetadata: vi.fn().mockResolvedValue(currentVersion()),
    };
    TestBed.configureTestingModule({
      imports: [SchemaShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ id: 'schema-1' })),
            queryParamMap: of(convertToParamMap({})),
          },
        },
        { provide: SchemaService, useValue: schemaService },
        { provide: CredentialConfigService, useValue: { loadConfigurations: async () => [] } },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: JwtService, useValue: jwtWithRoles('registrar:manage', 'issuance:manage') },
      ],
    });
    const fixture = TestBed.createComponent(SchemaShowComponent);
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.item).toBeDefined());
    await vi.waitFor(() => expect(fixture.componentInstance.loading).toBe(false));
    await vi.waitFor(() => expect(fixture.componentInstance.loadState.vocabularies).toBe('loaded'));
    fixture.componentInstance.togglePublishForm();
    fixture.detectChanges();
    return fixture;
  }

  function publishCardText(fixture: { nativeElement: HTMLElement }): string {
    return fixture.nativeElement.querySelector('mat-card-content p')?.textContent ?? '';
  }

  it('says what the new version keeps and leaves out before publishing', async () => {
    const fixture = await render();

    const text = publishCardText(fixture);
    expect(text).toContain('keeps the name, category and tags of version 1.0.0');
    expect(text).toContain('not carried over: legacy-tag');
    expect(text).not.toContain('Unsaved changes');
  });

  it('says the ID becomes the name when the current version has none', async () => {
    const fixture = await render(currentVersion({ displayName: '' }));

    expect(publishCardText(fixture)).toContain(
      'keeps the category and tags of version 1.0.0 and uses its ID as name'
    );
  });

  it('warns that unsaved catalog metadata is not included until it is saved', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;

    component.metadataForm.controls.displayName.setValue('Renamed PID');
    component.metadataForm.markAsDirty();
    fixture.detectChanges();
    expect(publishCardText(fixture)).toContain('Unsaved changes under Catalog Metadata');

    await component.saveMetadata();
    fixture.detectChanges();
    expect(publishCardText(fixture)).not.toContain('Unsaved changes');
  });
});

describe('SchemaShowComponent page', () => {
  let schemaService: Record<string, ReturnType<typeof vi.fn>>;

  function createFixture(roles = ['registrar:manage', 'issuance:manage']) {
    TestBed.configureTestingModule({
      imports: [SchemaShowComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: of(convertToParamMap({ id: 'schema-1' })),
            queryParamMap: of(convertToParamMap({})),
          },
        },
        { provide: SchemaService, useValue: schemaService },
        {
          provide: CredentialConfigService,
          useValue: {
            loadConfigurations: async () => [
              { id: 'pid', vct: 'urn:eudi:pid:1', config: { format: 'dc+sd-jwt' } },
            ],
          },
        },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: JwtService, useValue: jwtWithRoles(...roles) },
      ],
    });
    return TestBed.createComponent(SchemaShowComponent);
  }

  async function render(roles?: string[]) {
    const fixture = createFixture(roles);
    const load = vi.spyOn(fixture.componentInstance, 'load');
    fixture.detectChanges();
    await load.mock.results[0].value;
    fixture.detectChanges();
    return fixture;
  }

  function text(fixture: { nativeElement: HTMLElement }): string {
    return fixture.nativeElement.textContent ?? '';
  }

  function button(fixture: { nativeElement: HTMLElement }, label: string): HTMLElement {
    const element = fixture.nativeElement.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    expect(element, `button "${label}"`).not.toBeNull();
    return element!;
  }

  beforeEach(() => {
    schemaService = {
      getById: vi.fn().mockResolvedValue(currentVersion()),
      getVersions: vi.fn().mockResolvedValue([{ version: '1.0.0' }]),
      getVocabularies: vi.fn().mockResolvedValue(vocabularies),
      list: vi.fn(),
      publishSchemaMetadataVersion: vi.fn().mockResolvedValue({ id: 'schema-1', version: '1.1.0' }),
      deprecateVersion: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says that the schema is loading', () => {
    schemaService['getById'].mockReturnValue(new Promise(() => undefined));
    const fixture = createFixture();

    fixture.detectChanges();

    // <output> is a status live region.
    const status = fixture.nativeElement.querySelector('output');
    expect(status?.textContent).toContain('Loading schema…');
  });

  it('shows the reason and a Retry button when the schema cannot be loaded', async () => {
    schemaService['getById'].mockRejectedValue({ statusCode: 404, message: 'Not Found' });

    const fixture = await render();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Failed to load schema: Not Found');
    expect(alert?.textContent).toContain('Retry');
    expect(alert?.textContent).toContain('Back to list');
    expect(alert?.querySelector('a[href="/registrar"]')?.textContent).toContain(
      'Registrar configuration'
    );
    expect(fixture.nativeElement.querySelector('[aria-label="Delete version 1.0.0"]')).toBeNull();
  });

  it('labels the icon-only header buttons for screen readers', async () => {
    const fixture = await render();

    for (const label of [
      'Back to list',
      'Copy signed JWT',
      'Download export',
      'Publish new version',
      'Deprecate version 1.0.0',
      'Delete version 1.0.0',
      'Open trust list tl-1',
    ]) {
      button(fixture, label);
    }
  });

  it('links trust lists only for users who can open them', async () => {
    const fixture = await render(['registrar:manage']);

    expect(fixture.nativeElement.querySelector('[aria-label="Open trust list tl-1"]')).toBeNull();
    expect(text(fixture)).toContain('https://eudiplo.example/issuers/acme/trust-list/tl-1');
  });

  it('shows the stored category and tags, also without the vocabulary', async () => {
    schemaService['getVocabularies'].mockRejectedValue({ statusCode: 502, message: 'Bad Gateway' });

    const fixture = await render();

    expect(text(fixture)).toContain('identity');
    expect(text(fixture)).toContain('pid, legacy-tag, eudi');
  });

  it('enables Save only for changed catalog metadata', async () => {
    const fixture = await render();
    const element = fixture.nativeElement as HTMLElement;
    const save = () =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === 'Save'
      )!;
    expect(save().disabled).toBe(true);

    fixture.componentInstance.metadataForm.controls.displayName.setValue('Renamed PID');
    fixture.componentInstance.metadataForm.markAsDirty();
    fixture.detectChanges();
    expect(save().disabled).toBe(false);
  });

  it('offers no Deprecate for a version that is deprecated already', async () => {
    schemaService['getById'].mockResolvedValue(currentVersion({ deprecated: true }));

    const fixture = await render();

    expect(
      fixture.nativeElement.querySelector('[aria-label="Deprecate version 1.0.0"]')
    ).toBeNull();
    expect(text(fixture)).toContain('This version is deprecated.');
  });

  it('names an empty New Version as missing in the publish card', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    component.togglePublishForm();
    fixture.detectChanges();

    component.publishForm.controls.newVersion.setValue('');
    component.publishForm.controls.newVersion.markAsTouched();
    fixture.detectChanges();

    expect(text(fixture)).toContain('New version is required.');
    expect(text(fixture)).not.toContain('Must be a valid semantic version');
  });

  it('disables Publish without issuance:manage and names the role', async () => {
    const fixture = await render(['registrar:manage']);

    const publish = button(fixture, 'Publish new version');
    expect(publish.getAttribute('aria-disabled')).toBe('true');
    expect(text(fixture)).toContain(
      'Listing the credential configs that reference this schema needs the issuance:manage role.'
    );

    publish.click();
    fixture.detectChanges();
    expect(text(fixture)).not.toContain('Publish New Version');
  });

  it('says in the hints that categories and tags could not be loaded', async () => {
    schemaService['getVocabularies'].mockRejectedValue({ statusCode: 502, message: 'Bad Gateway' });

    const fixture = await render();

    expect(text(fixture)).toContain('Could not load categories from the registrar.');
    expect(text(fixture)).toContain('Could not load tags from the registrar.');
  });

  it('does not navigate after a publish that finishes once the user has left', async () => {
    let finishPublish!: (entry: unknown) => void;
    schemaService['publishSchemaMetadataVersion'].mockReturnValue(
      new Promise((resolve) => (finishPublish = resolve))
    );
    const fixture = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');

    const publishing = fixture.componentInstance.publishNewVersion();
    fixture.destroy();
    finishPublish({ id: 'schema-1', version: '1.1.0' });
    await publishing;

    expect(schemaService['publishSchemaMetadataVersion']).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('disables Publish with the reason while the credential configs are loading', async () => {
    TestBed.overrideProvider(CredentialConfigService, {
      useValue: { loadConfigurations: () => new Promise(() => undefined) },
    });
    const fixture = createFixture();
    fixture.detectChanges();
    await vi.waitFor(() => expect(fixture.componentInstance.item).toBeDefined());
    fixture.componentInstance.togglePublishForm();
    fixture.detectChanges();

    const element = fixture.nativeElement as HTMLElement;
    const publish = [...element.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Publish'
    )!;
    expect(publish.disabled).toBe(true);
    expect(text(fixture)).toContain('Loading credential configs and the registrar vocabulary…');
  });

  it('does not navigate after a delete that finishes once the user has left', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishDelete!: () => void;
    schemaService['delete'].mockReturnValue(
      new Promise<void>((resolve) => (finishDelete = resolve))
    );
    const fixture = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');

    const deleting = fixture.componentInstance.delete();
    fixture.destroy();
    finishDelete();
    await deleting;

    expect(schemaService['delete']).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });
});
