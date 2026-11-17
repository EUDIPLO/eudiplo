import { Injectable } from '@angular/core';
import {
  type CreatedOidcClientResponseDto,
  type CreatedOidcClientSecretResponseDto,
  type CreateOidcClientDto,
  type OidcClientResponseDto,
  type OidcClientSecretDto,
  type UpdateOidcClientDto,
  oidcClientControllerAddSecret,
  oidcClientControllerCreate,
  oidcClientControllerDelete,
  oidcClientControllerDeleteSecret,
  oidcClientControllerGet,
  oidcClientControllerList,
  oidcClientControllerUpdate,
  oidcClientControllerUpdateSecret,
} from '@eudiplo/sdk-core';

/** OpenID Connect clients of the tenant, which sign users in with a wallet. */
@Injectable({
  providedIn: 'root',
})
export class OidcClientService {
  async getAll(): Promise<OidcClientResponseDto[]> {
    const response = await oidcClientControllerList();
    return response.data ?? [];
  }

  async getById(id: string): Promise<OidcClientResponseDto> {
    const response = await oidcClientControllerGet({ path: { id } });
    return response.data;
  }

  /** Creates a client; the response holds its secret, which cannot be read again. */
  async create(body: CreateOidcClientDto): Promise<CreatedOidcClientResponseDto> {
    const response = await oidcClientControllerCreate({ body });
    return response.data;
  }

  async update(id: string, body: UpdateOidcClientDto): Promise<OidcClientResponseDto> {
    const response = await oidcClientControllerUpdate({ path: { id }, body });
    return response.data;
  }

  async delete(id: string): Promise<void> {
    await oidcClientControllerDelete({ path: { id } });
  }

  /** Adds a secret; the response holds it, and it cannot be read again. */
  async addSecret(id: string): Promise<CreatedOidcClientSecretResponseDto> {
    const response = await oidcClientControllerAddSecret({ path: { id } });
    return response.data;
  }

  /** Sets the moment from which the secret is refused, or null to keep it valid. */
  async setSecretExpiry(
    id: string,
    secretId: string,
    expiresAt: string | null
  ): Promise<OidcClientSecretDto> {
    const response = await oidcClientControllerUpdateSecret({
      path: { id, secretId },
      body: { expiresAt },
    });
    return response.data;
  }

  async deleteSecret(id: string, secretId: string): Promise<void> {
    await oidcClientControllerDeleteSecret({ path: { id, secretId } });
  }
}
