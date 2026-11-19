import { Injectable } from '@angular/core';
import {
  type CreateUserDto,
  type ManagedUserDto,
  type UpdateUserDto,
  userControllerCreateUser,
  userControllerDeleteUser,
  userControllerGetUser,
  userControllerGetUsers,
  userControllerUpdateUser,
} from '@eudiplo/sdk-core';

/** The people who sign in to the Web Client with a username and password. */
@Injectable({ providedIn: 'root' })
export class UserService {
  async getAll(): Promise<ManagedUserDto[]> {
    const response = await userControllerGetUsers();
    return response.data;
  }

  async getById(id: string): Promise<ManagedUserDto | undefined> {
    const response = await userControllerGetUser({ path: { id } });
    return response.data;
  }

  /** Creates the user; the answer carries its one-time temporary password, if any. */
  async create(dto: CreateUserDto): Promise<ManagedUserDto | undefined> {
    const response = await userControllerCreateUser({ body: dto });
    return response.data;
  }

  async update(id: string, dto: UpdateUserDto): Promise<void> {
    await userControllerUpdateUser({ path: { id }, body: dto });
  }

  async delete(id: string): Promise<void> {
    await userControllerDeleteUser({ path: { id } });
  }
}
