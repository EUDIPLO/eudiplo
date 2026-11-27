import { Injectable } from '@angular/core';
import {
  configPortabilityControllerDetach,
  configPortabilityControllerPlanReattach,
  configPortabilityControllerReattach,
  configPortabilityControllerResources,
  configPortabilityControllerResourcesOfKind,
  type ConfigResourceMetadataEntity,
  type ConfigResourceOwnershipDto,
} from '@eudiplo/sdk-core';
import { ApiService } from '../core';
import { JwtService, type Role } from '../services/jwt.service';

export type ConfigResourceKind = ConfigResourceOwnershipDto['kind'];

export type ConfigResourceOwnership = ConfigResourceOwnershipDto;

const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Roles that may read the ownership of each kind, as `mayReadConfigOwnership`
 * in the backend checks them: `tenant:admin` and the roles that change the
 * kind. A reader gets 403, which the Web Client would take for lost roles.
 */
const OWNERSHIP_READ_ROLES: Record<ConfigResourceKind, Role[]> = {
  Tenant: ['tenant:admin', 'issuance:manage', 'presentation:manage'],
  Client: ['tenant:admin', 'clients:manage'],
  KmsConfig: ['tenant:admin', 'keys:export'],
  KeyChain: ['tenant:admin', 'keys:manage'],
  KeyChainDefaults: ['tenant:admin', 'keys:manage'],
  IssuanceConfig: ['tenant:admin', 'issuance:manage'],
  CredentialConfig: ['tenant:admin', 'issuance:manage'],
  PresentationConfig: ['tenant:admin', 'presentation:manage'],
  AttributeProvider: ['tenant:admin', 'issuance:manage'],
  WebhookEndpoint: ['tenant:admin', 'issuance:manage', 'presentation:manage'],
  TrustList: ['tenant:admin', 'issuance:manage', 'presentation:manage'],
  FederationTrustAnchor: ['tenant:admin', 'issuance:manage', 'presentation:manage'],
  StatusList: ['tenant:admin', 'issuance:manage'],
};

export interface ConfigResourceMetadata extends ConfigResourceOwnership {
  tenantId: string;
}

/**
 * A file-managed client from the config folder. Config Portability offers
 * "Apply from file" for it, which gives a client with "secret": "!generate" a
 * new secret that a startup import cannot show.
 */
export function offersApplyFromFile(
  kind: ConfigResourceKind,
  metadata?: Pick<ConfigResourceOwnership, 'ownership' | 'source'>
): boolean {
  return (
    kind === 'Client' &&
    metadata?.ownership === 'file-managed' &&
    !!metadata.source?.startsWith('folder:')
  );
}

/**
 * A resource Config Portability offers "Reset to file" for, which applies its
 * version from the config folder again. A resource from an uploaded bundle has
 * no folder version. Most tenants change their settings and default key chains
 * through the API, so these only offer it once detached from a folder.
 */
export function offersResetToFile(
  kind: ConfigResourceKind,
  metadata?: Pick<ConfigResourceOwnership, 'ownership' | 'source'>
): boolean {
  if (!metadata || metadata.ownership === 'file-managed') return false;
  if (metadata.source?.startsWith('bundle:')) return false;
  return (kind !== 'Tenant' && kind !== 'KeyChainDefaults') || metadata.ownership === 'detached';
}

@Injectable({ providedIn: 'root' })
export class ConfigOwnershipService {
  /** Lookups still in flight, so the lock notice and buttons of one screen share a request. */
  private readonly pending = new Map<ConfigResourceKind, Promise<ConfigResourceOwnership[]>>();

  constructor(
    private readonly api: ApiService,
    private readonly jwt: JwtService
  ) {}

  /** Every resource of the tenant. Needs `tenant:admin` or `tenants:manage`. */
  async list(): Promise<ConfigResourceMetadata[]> {
    const result = await configPortabilityControllerResources<true>({ client: this.api.client });
    return result.data as ConfigResourceMetadata[];
  }

  /**
   * Resources of one kind, readable with any role that manages the kind. Not
   * cached beyond the request, so a later screen or another login sees the
   * current state.
   */
  private listKind(kind: ConfigResourceKind): Promise<ConfigResourceOwnership[]> {
    const pending = this.pending.get(kind);
    if (pending) return pending;
    const request = configPortabilityControllerResourcesOfKind<true>({
      client: this.api.client,
      path: { kind },
      // Locked buttons wait for the answer; a stalled request must not block them for good.
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    })
      .then((result) => result.data)
      .finally(() => this.pending.delete(kind));
    this.pending.set(kind, request);
    return request;
  }

  /**
   * The ownership of one resource; undefined without a role that changes the
   * kind, since such a caller cannot change the resource either way.
   */
  async get(
    kind: ConfigResourceKind,
    resourceId: string
  ): Promise<ConfigResourceOwnership | undefined> {
    if (!this.jwt.hasRole(OWNERSHIP_READ_ROLES[kind])) return undefined;
    return (await this.listKind(kind)).find((resource) => resource.resourceId === resourceId);
  }

  async detach(kind: ConfigResourceKind, resourceId: string): Promise<ConfigResourceMetadata> {
    const result = await configPortabilityControllerDetach<true>({
      client: this.api.client,
      path: { kind, id: resourceId },
    });
    return result.data as ConfigResourceMetadataEntity as ConfigResourceMetadata;
  }

  /** Plans resetting a resource to its version in the server's config folder. */
  async planReattach(kind: ConfigResourceKind, resourceId: string): Promise<unknown> {
    const result = await configPortabilityControllerPlanReattach<true>({
      client: this.api.client,
      path: { kind, id: resourceId },
    });
    return result.data;
  }

  async reattach(
    kind: ConfigResourceKind,
    resourceId: string,
    planFingerprint: string
  ): Promise<unknown> {
    const result = await configPortabilityControllerReattach<true>({
      client: this.api.client,
      path: { kind, id: resourceId },
      query: { planFingerprint },
    });
    return result.data;
  }
}
