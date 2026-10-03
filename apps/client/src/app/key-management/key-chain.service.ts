import { Injectable } from '@angular/core';
import {
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
  keyChainControllerExport,
  keyChainControllerGetAll,
  keyChainControllerGetById,
  keyChainControllerGetProviders,
  keyChainControllerGetProvidersHealth,
  keyChainControllerGetTenantKmsConfig,
  keyChainControllerImport,
  keyChainControllerRotate,
  keyChainControllerUpdate,
  keyChainControllerUpdateTenantKmsConfig,
} from '@eudiplo/sdk-core';
import type { Role } from '../services/jwt.service';

/**
 * Roles allowed to export key material and to manage the tenant KMS provider
 * configuration (which contains provider credentials). The same roles as for
 * the configuration export.
 */
export const KEY_ADMIN_ROLES: Role[] = ['tenant:admin', 'tenants:manage'];

/** Message shown when the backend rejects a key administration request. */
export const KEY_ADMIN_FORBIDDEN_MESSAGE =
  'This action requires the tenant:admin or tenants:manage role';

/** True when the SDK error is the backend's 403 response. */
export function isForbidden(error: unknown): boolean {
  return (error as { statusCode?: number } | undefined)?.statusCode === 403;
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

  /** Requires one of {@link KEY_ADMIN_ROLES}. */
  async getTenantKmsConfig(): Promise<KmsTenantConfigResponseDto> {
    const response = await keyChainControllerGetTenantKmsConfig();
    return response.data as KmsTenantConfigResponseDto;
  }

  /** Requires one of {@link KEY_ADMIN_ROLES}. */
  async updateTenantKmsConfig(config: KmsConfigDto): Promise<KmsTenantConfigResponseDto> {
    const response = await keyChainControllerUpdateTenantKmsConfig({
      body: config,
    });
    return response.data as KmsTenantConfigResponseDto;
  }

  /** Requires one of {@link KEY_ADMIN_ROLES}. */
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
   * Export a key chain in config-import-compatible format (includes the private
   * key of database-held keys). Requires the tenant:admin or tenants:manage role.
   */
  async export(id: string): Promise<Record<string, unknown>> {
    const response = await keyChainControllerExport({ path: { id } });
    return response.data as Record<string, unknown>;
  }
}
