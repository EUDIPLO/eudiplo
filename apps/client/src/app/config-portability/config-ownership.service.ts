import { Injectable } from '@angular/core';
import {
  configPortabilityControllerDetach,
  configPortabilityControllerPlanReattach,
  configPortabilityControllerReattach,
  configPortabilityControllerResources,
  type ConfigResourceMetadataEntity,
} from '@eudiplo/sdk-core';
import { ApiService } from '../core';

export type ConfigResourceKind =
  | 'Tenant'
  | 'Client'
  | 'KmsConfig'
  | 'KeyChain'
  | 'RegistrarConfig'
  | 'IssuanceConfig'
  | 'CredentialConfig'
  | 'PresentationConfig'
  | 'AttributeProvider'
  | 'WebhookEndpoint'
  | 'TrustList'
  | 'StatusList';

export interface ConfigResourceMetadata {
  tenantId: string;
  kind: ConfigResourceKind;
  resourceId: string;
  ownership: 'unmanaged' | 'file-managed' | 'detached';
  generation: number;
  source?: string;
  lastAppliedAt?: string;
}

@Injectable({ providedIn: 'root' })
export class ConfigOwnershipService {
  private resources?: Promise<ConfigResourceMetadata[]>;

  constructor(private readonly api: ApiService) {}

  list(force = false): Promise<ConfigResourceMetadata[]> {
    if (force || !this.resources) {
      this.resources = configPortabilityControllerResources<true>({ client: this.api.client })
        .then((result) => result.data as ConfigResourceMetadata[])
        .catch((error: unknown) => {
          this.resources = undefined;
          throw error;
        });
    }
    return this.resources;
  }

  async get(
    kind: ConfigResourceKind,
    resourceId: string
  ): Promise<ConfigResourceMetadata | undefined> {
    return (await this.list()).find(
      (resource) => resource.kind === kind && resource.resourceId === resourceId
    );
  }

  async isManaged(kind: ConfigResourceKind, resourceId: string): Promise<boolean> {
    return (await this.get(kind, resourceId))?.ownership === 'file-managed';
  }

  async detach(kind: ConfigResourceKind, resourceId: string): Promise<ConfigResourceMetadata> {
    const result = await configPortabilityControllerDetach<true>({
      client: this.api.client,
      path: { kind, id: resourceId },
    });
    const metadata = result.data as ConfigResourceMetadataEntity as ConfigResourceMetadata;
    await this.list(true);
    return metadata;
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
    await this.list(true);
    return result.data;
  }

  invalidate(): void {
    this.resources = undefined;
  }
}
