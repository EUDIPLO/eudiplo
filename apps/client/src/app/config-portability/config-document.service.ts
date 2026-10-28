import { Injectable, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { configPortabilityControllerExportDocument } from '@eudiplo/sdk-core';
import { ApiService } from '../core';
import { downloadJsonFile } from '../common/download-json.util';
import { JwtService, TENANT_ADMIN_ROLES, type Role } from '../services/jwt.service';
import {
  apiErrorDetail,
  asSentence,
  getApiErrorMessage,
  hasHttpStatus,
} from '../utils/error-message';
import { openErrorSnackBar } from '../utils/error-snackbar';
import type { ConfigResourceKind } from './config-ownership.service';

/**
 * Roles that may download a resource of each kind as a configuration
 * document, mirroring `mayExportConfigDocument` in the backend. A key chain
 * document carries the private keys of keys held in the database.
 */
const CONFIG_DOCUMENT_ROLES: Record<ConfigResourceKind, Role[]> = {
  Tenant: [...TENANT_ADMIN_ROLES, 'issuance:manage', 'presentation:manage'],
  Client: [...TENANT_ADMIN_ROLES, 'clients:manage'],
  KmsConfig: TENANT_ADMIN_ROLES,
  KeyChain: TENANT_ADMIN_ROLES,
  KeyChainDefaults: [
    ...TENANT_ADMIN_ROLES,
    'issuance:manage',
    'presentation:manage',
    'keys:manage',
  ],
  RegistrarConfig: [...TENANT_ADMIN_ROLES, 'registrar:manage'],
  IssuanceConfig: [...TENANT_ADMIN_ROLES, 'issuance:manage'],
  CredentialConfig: [...TENANT_ADMIN_ROLES, 'issuance:manage'],
  PresentationConfig: [...TENANT_ADMIN_ROLES, 'presentation:manage'],
  AttributeProvider: [...TENANT_ADMIN_ROLES, 'issuance:manage'],
  WebhookEndpoint: [...TENANT_ADMIN_ROLES, 'issuance:manage', 'presentation:manage'],
  TrustList: [...TENANT_ADMIN_ROLES, 'issuance:manage', 'presentation:manage'],
  FederationTrustAnchor: [...TENANT_ADMIN_ROLES, 'issuance:manage', 'presentation:manage'],
  StatusList: [...TENANT_ADMIN_ROLES, 'issuance:manage'],
};

/** True for the backend role guard's `403`, whose reason names no roles. */
function isRoleRefusal(error: unknown): boolean {
  return hasHttpStatus(error, 403) && apiErrorDetail(error) === 'Forbidden resource';
}

/**
 * Downloads one resource as a configuration document (`$schema` and `spec`),
 * the file format of the config folder, so the file can be imported again.
 */
@Injectable({ providedIn: 'root' })
export class ConfigDocumentService {
  /** `<kind>/<id>` of each document whose download is running. */
  private readonly running = signal<ReadonlySet<string>>(new Set());

  constructor(
    private readonly api: ApiService,
    private readonly jwt: JwtService,
    private readonly snackBar: MatSnackBar
  ) {}

  canDownload(kind: ConfigResourceKind): boolean {
    return this.jwt.hasRole(CONFIG_DOCUMENT_ROLES[kind]);
  }

  /** True while the document of the resource is being downloaded, to disable its button. */
  isDownloading(kind: ConfigResourceKind, id: string): boolean {
    return this.running().has(`${kind}/${id}`);
  }

  /**
   * Downloads the document and says in a snackbar that it was saved or why it
   * was not. A second call for the same resource while the first runs does
   * nothing, so a double click saves one file and writes one audit entry.
   */
  async downloadWithFeedback(kind: ConfigResourceKind, id: string): Promise<void> {
    const key = `${kind}/${id}`;
    if (this.running().has(key)) return;
    this.running.update((running) => new Set(running).add(key));
    try {
      const placeholders = await this.download(kind, id);
      // Secrets are `${…}` placeholders that an import needs as environment variables.
      if (placeholders.length) {
        this.snackBar.open(
          `Configuration downloaded. Its secrets are placeholders: set ${placeholders.join(', ')} before importing it.`,
          'Close',
          { duration: 8000 }
        );
      } else {
        this.snackBar.open('Configuration downloaded', 'Close', { duration: 3000 });
      }
    } catch (error) {
      const message = getApiErrorMessage(error, 'Failed to download configuration');
      // A stale token can still show the button. The role guard's refusal names
      // no roles, unlike the document check's own reason, so add them.
      openErrorSnackBar(
        this.snackBar,
        isRoleRefusal(error)
          ? `${asSentence(message)} It requires one of the roles ${CONFIG_DOCUMENT_ROLES[kind].join(', ')}.`
          : message
      );
    } finally {
      this.running.update((running) => {
        const next = new Set(running);
        next.delete(key);
        return next;
      });
    }
  }

  /**
   * Saves the document as `<id>.json`, the file name the config folder uses,
   * and returns the names of the `${…}` placeholders it has for secrets.
   */
  async download(kind: ConfigResourceKind, id: string): Promise<string[]> {
    const result = await configPortabilityControllerExportDocument<true>({
      client: this.api.client,
      path: { kind, id },
    });
    downloadJsonFile(result.data, `${id}.json`);
    return [
      ...new Set(
        Array.from(JSON.stringify(result.data).matchAll(/\$\{(\w+)\}/g), ([, name]) => name)
      ),
    ];
  }
}
