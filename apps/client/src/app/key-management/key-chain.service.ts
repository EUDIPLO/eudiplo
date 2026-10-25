import { Injectable } from '@angular/core';
import {
  type DefaultAccessKeyChainDto,
  type KmsConfigDto,
  type KmsProvidersResponseDto,
  type KmsTenantConfigResponseDto,
  type KeyChainCreateDto,
  type KeyChainImportDto,
  type KeyChainResponseDto,
  type KeyChainUpdateDto,
  keyChainControllerCreate,
  keyChainControllerDelete,
  keyChainControllerDeleteTenantKmsConfig,
  keyChainControllerGetAll,
  keyChainControllerGetById,
  keyChainControllerGetProviders,
  keyChainControllerGetProvidersHealth,
  keyChainControllerGetTenantKmsConfig,
  keyChainControllerImport,
  keyChainControllerRotate,
  keyChainControllerUpdate,
  keyChainControllerUpdateTenantKmsConfig,
  defaultAccessKeyChainControllerGet,
  defaultAccessKeyChainControllerSet,
} from '@eudiplo/sdk-core';
import type { Role } from '../services/jwt.service';
import { hasHttpStatus } from '../utils/error-message';

/** Roles that list, create, rotate and delete key chains and read the KMS providers. */
export const KEY_CHAIN_ROLES: Role[] = ['issuance:manage', 'presentation:manage', 'keys:manage'];

/** Message shown when the backend rejects a key administration request. */
export const KEY_ADMIN_FORBIDDEN_MESSAGE =
  'This action requires the tenant:admin or tenants:manage role';

/** True when the SDK error is the backend's 403 response. */
export function isForbidden(error: unknown): boolean {
  return hasHttpStatus(error, 403);
}

/**
 * Service for managing unified key chains.
 *
 * A key chain encapsulates:
 * - An optional root CA key (for internal certificate chains)
 * - An active signing key with its certificate
 * - Rotation policy and previous keys (for grace period)
 */
@Injectable({
  providedIn: 'root',
})
export class KeyChainService {
  /**
   * Get available KMS providers and configured default provider.
   */
  async getProviders(): Promise<KmsProvidersResponseDto> {
    const response = await keyChainControllerGetProviders();
    return response.data as KmsProvidersResponseDto;
  }

  /**
   * Get runtime health for all configured KMS providers.
   */
  async getProvidersHealth(): Promise<
    {
      providerId: string;
      type: string;
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }[]
  > {
    const response = await keyChainControllerGetProvidersHealth();
    return (
      (response.data as
        | {
            providerId: string;
            type: string;
            ok: boolean;
            latencyMs?: number;
            error?: string;
          }[]
        | undefined) || []
    );
  }

  /** Requires tenant:admin or tenants:manage. */
  async getTenantKmsConfig(): Promise<KmsTenantConfigResponseDto> {
    const response = await keyChainControllerGetTenantKmsConfig();
    return response.data as KmsTenantConfigResponseDto;
  }

  /** Requires tenant:admin or tenants:manage. */
  async updateTenantKmsConfig(config: KmsConfigDto): Promise<KmsTenantConfigResponseDto> {
    const response = await keyChainControllerUpdateTenantKmsConfig({
      body: config,
    });
    return response.data as KmsTenantConfigResponseDto;
  }

  /** Requires tenant:admin or tenants:manage. */
  async deleteTenantKmsConfig(): Promise<void> {
    await keyChainControllerDeleteTenantKmsConfig();
  }

  /**
   * Get all key chains for the current tenant.
   */
  async getAll(): Promise<KeyChainResponseDto[]> {
    const response = await keyChainControllerGetAll();
    return (response.data as KeyChainResponseDto[]) || [];
  }

  /**
   * Get a specific key chain by ID.
   */
  async getById(id: string): Promise<KeyChainResponseDto> {
    const response = await keyChainControllerGetById({ path: { id } });
    return response.data as KeyChainResponseDto;
  }

  /**
   * Create a new key chain.
   */
  async create(data: KeyChainCreateDto): Promise<{ id: string }> {
    const response = await keyChainControllerCreate({ body: data });
    return response.data as { id: string };
  }

  /** Import key material and an externally issued certificate chain. */
  async import(data: KeyChainImportDto): Promise<{ id: string }> {
    const response = await keyChainControllerImport({ body: data });
    return response.data as { id: string };
  }

  /**
   * Update a key chain.
   */
  async update(id: string, data: KeyChainUpdateDto): Promise<void> {
    await keyChainControllerUpdate({ path: { id }, body: data });
  }

  /**
   * Delete a key chain.
   */
  async delete(id: string): Promise<void> {
    await keyChainControllerDelete({ path: { id } });
  }

  /**
   * Manually trigger key rotation for a key chain.
   */
  async rotate(id: string): Promise<void> {
    await keyChainControllerRotate({ path: { id } });
  }

  /**
   * The tenant's default access key chain setting and the access key chain
   * used where no configuration names one.
   */
  async getDefaultAccess(): Promise<DefaultAccessKeyChainDto> {
    const response = await defaultAccessKeyChainControllerGet();
    return response.data as DefaultAccessKeyChainDto;
  }

  /**
   * Names the tenant's default access key chain, or with null lets the
   * backend pick one by rule again.
   */
  async setDefaultAccess(keyChainId: string | null): Promise<DefaultAccessKeyChainDto> {
    const response = await defaultAccessKeyChainControllerSet({
      body: { defaultAccessKeyChainId: keyChainId },
    });
    return response.data as DefaultAccessKeyChainDto;
  }
}
