import { Injectable } from '@angular/core';
import {
  clientControllerCreateClient,
  clientControllerDeleteClient,
  clientControllerGetClient,
  clientControllerGetClients,
  clientControllerRotateClientSecret,
  clientControllerUpdateClient,
  type ClientEntity,
  type CreateClientDto,
  type UpdateClientDto,
} from '@eudiplo/sdk-core';

/** The API clients of the caller's tenant, which services sign in with. */
@Injectable({ providedIn: 'root' })
export class ApiClientService {
  async getAll(): Promise<ClientEntity[]> {
    const response = await clientControllerGetClients();
    return response.data;
  }

  async getById(id: string): Promise<ClientEntity | undefined> {
    const response = await clientControllerGetClient({ path: { id } });
    return response.data;
  }

  /** Creates the client; the answer carries its generated secret, if the backend made one. */
  async create(
    dto: CreateClientDto
  ): Promise<(ClientEntity & { clientSecret?: string }) | undefined> {
    const response = await clientControllerCreateClient({ body: dto });
    return response.data;
  }

  async update(id: string, dto: UpdateClientDto): Promise<void> {
    await clientControllerUpdateClient({ path: { id }, body: dto });
  }

  async delete(id: string): Promise<void> {
    await clientControllerDeleteClient({ path: { id } });
  }

  /** Gives the client a new secret; the old one stops working. Returns the new secret, if any. */
  async rotateSecret(id: string): Promise<string | undefined> {
    const response = await clientControllerRotateClientSecret({ path: { id } });
    return response.data?.secret;
  }
}
