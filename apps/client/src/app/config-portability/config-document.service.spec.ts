import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { client } from '@eudiplo/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '../services/jwt.service';
import { ConfigDocumentService } from './config-document.service';

describe('ConfigDocumentService', () => {
  let snackBar: { open: ReturnType<typeof vi.fn> };

  function create(roles: string[]): ConfigDocumentService {
    snackBar = { open: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        {
          provide: JwtService,
          useValue: { hasRole: (role: string[]) => role.some((r) => roles.includes(r)) },
        },
        { provide: MatSnackBar, useValue: snackBar },
      ],
    });
    return TestBed.inject(ConfigDocumentService);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    client.setConfig({ fetch: () => new Promise<Response>(() => undefined) });
  });

  it('saves the document of a resource as <id>.json', async () => {
    const document = {
      $schema: 'https://eudiplo.dev/schemas/v2/CredentialConfigFile.schema.json',
      spec: { id: 'pid' },
    };
    const paths: string[] = [];
    client.setConfig({
      fetch: async (request: RequestInfo | URL) => {
        paths.push(new URL(request instanceof Request ? request.url : String(request)).pathname);
        return new Response(JSON.stringify(document), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    // jsdom has no object URLs; keep the file handed to the browser.
    const { createObjectURL, revokeObjectURL } = URL;
    const files: Blob[] = [];
    URL.createObjectURL = (blob: Blob) => (files.push(blob), 'blob:document');
    URL.revokeObjectURL = () => undefined;

    try {
      await expect(
        create(['issuance:manage']).download('CredentialConfig', 'pid')
      ).resolves.toEqual([]);
    } finally {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    }

    expect(paths).toEqual(['/api/config-bundles/resources/CredentialConfig/pid/document']);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('pid.json');
    expect(JSON.parse(await files[0].text())).toEqual(document);
  });

  it('names the placeholders an import of the document needs', async () => {
    client.setConfig({
      fetch: async () =>
        new Response(
          JSON.stringify({
            $schema: 'https://eudiplo.dev/schemas/v1/WebhookEndpointConfigFile.schema.json',
            spec: {
              id: 'hook',
              auth: { config: { value: '${WEBHOOKENDPOINT_HOOK_AUTH_CONFIG_VALUE}' } },
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        ),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = () => 'blob:document';
    URL.revokeObjectURL = () => undefined;

    try {
      await expect(
        create(['issuance:manage']).download('WebhookEndpoint', 'hook')
      ).resolves.toEqual(['WEBHOOKENDPOINT_HOOK_AUTH_CONFIG_VALUE']);
    } finally {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    }
  });

  describe('downloadWithFeedback', () => {
    it('says that the document was saved', async () => {
      const service = create(['issuance:manage']);
      vi.spyOn(service, 'download').mockResolvedValue([]);

      await service.downloadWithFeedback('CredentialConfig', 'pid');

      expect(service.download).toHaveBeenCalledWith('CredentialConfig', 'pid');
      expect(snackBar.open).toHaveBeenCalledWith('Configuration downloaded', 'Close', {
        duration: 3000,
      });
    });

    it('names the placeholders to set before an import, for longer', async () => {
      const service = create(['issuance:manage']);
      vi.spyOn(service, 'download').mockResolvedValue(['HOOK_SECRET', 'HOOK_TOKEN']);

      await service.downloadWithFeedback('WebhookEndpoint', 'hook');

      expect(snackBar.open).toHaveBeenCalledWith(
        'Configuration downloaded. Its secrets are placeholders: set HOOK_SECRET, HOOK_TOKEN before importing it.',
        'Close',
        { duration: 8000 }
      );
    });

    it("shows the backend's reason when the download fails", async () => {
      const service = create(['issuance:manage']);
      vi.spyOn(service, 'download').mockRejectedValue({
        statusCode: 404,
        message: 'Credential configuration pid not found',
      });

      await service.downloadWithFeedback('CredentialConfig', 'pid');

      expect(snackBar.open.mock.lastCall?.[0]).toBe(
        'Failed to download configuration: Credential configuration pid not found'
      );
      expect(service.isDownloading('CredentialConfig', 'pid')).toBe(false);
    });

    it('names the roles that may download the document when the backend refuses it', async () => {
      const service = create(['tenant:admin']);
      vi.spyOn(service, 'download').mockRejectedValue({
        statusCode: 403,
        message: 'Forbidden resource',
      });

      await service.downloadWithFeedback('KeyChain', 'key');

      expect(snackBar.open.mock.lastCall?.[0]).toBe(
        'Failed to download configuration: Forbidden resource. It requires one of the roles tenant:admin, tenants:manage.'
      );
    });

    it("keeps the document check's own refusal, which names the roles, as it is", async () => {
      const service = create(['issuance:manage']);
      const reason =
        'A key chain document contains private keys and needs tenant:admin or tenants:manage.';
      vi.spyOn(service, 'download').mockRejectedValue({ statusCode: 403, message: reason });

      await service.downloadWithFeedback('KeyChain', 'key');

      expect(snackBar.open.mock.lastCall?.[0]).toBe(`Failed to download configuration: ${reason}`);
    });

    it('downloads a resource once while its download runs', async () => {
      const service = create(['issuance:manage']);
      let finish!: (placeholders: string[]) => void;
      vi.spyOn(service, 'download').mockReturnValue(
        new Promise<string[]>((resolve) => (finish = resolve))
      );

      const first = service.downloadWithFeedback('CredentialConfig', 'pid');
      await service.downloadWithFeedback('CredentialConfig', 'pid');

      expect(service.isDownloading('CredentialConfig', 'pid')).toBe(true);
      expect(service.isDownloading('CredentialConfig', 'other')).toBe(false);
      finish([]);
      await first;
      expect(service.download).toHaveBeenCalledTimes(1);
      expect(service.isDownloading('CredentialConfig', 'pid')).toBe(false);
    });
  });

  it('offers a kind to the roles that manage it', () => {
    const service = create(['issuance:manage']);

    expect(service.canDownload('CredentialConfig')).toBe(true);
    expect(service.canDownload('PresentationConfig')).toBe(false);
  });

  it.each([
    ['WebhookEndpoint', 'presentation:manage', true],
    ['TrustList', 'issuance:manage', true],
    ['FederationTrustAnchor', 'presentation:manage', true],
    ['FederationTrustAnchor', 'registrar:manage', false],
    ['Tenant', 'presentation:manage', true],
    ['Tenant', 'keys:manage', false],
    ['KeyChainDefaults', 'keys:manage', true],
    ['KeyChainDefaults', 'issuance:manage', true],
    ['KeyChainDefaults', 'clients:manage', false],
    ['StatusList', 'presentation:manage', false],
    ['AttributeProvider', 'presentation:manage', false],
    ['RegistrarConfig', 'registrar:manage', true],
    ['Client', 'clients:manage', true],
    ['Client', 'issuance:manage', false],
    ['KmsConfig', 'issuance:manage', false],
    ['KmsConfig', 'tenant:admin', true],
  ] as const)('offers %s to %s: %s', (kind, role, offered) => {
    expect(create([role]).canDownload(kind)).toBe(offered);
  });

  it('offers key chains, which carry private keys, only to tenant administrators', () => {
    expect(create(['keys:manage', 'issuance:manage']).canDownload('KeyChain')).toBe(false);
    TestBed.resetTestingModule();
    expect(create(['tenant:admin']).canDownload('KeyChain')).toBe(true);
  });
});
