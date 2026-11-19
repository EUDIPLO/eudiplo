import { Injectable } from '@angular/core';
import {
  statusListManagementControllerGetLists,
  statusListManagementControllerGetList,
  statusListManagementControllerCreateList,
  statusListManagementControllerUpdateList,
  statusListManagementControllerDeleteList,
  StatusListResponseDto,
  CreateStatusListDto,
  UpdateStatusListDto,
} from '@eudiplo/sdk-core';

@Injectable({
  providedIn: 'root',
})
export class StatusListManagementService {
  constructor() {}

  /**
   * Get all status lists for the current tenant
   */
  async getLists(): Promise<StatusListResponseDto[]> {
    const response = await statusListManagementControllerGetLists();
    return response.data || [];
  }

  /**
   * Get a specific status list by ID
   */
  async getList(listId: string): Promise<StatusListResponseDto> {
    const response = await statusListManagementControllerGetList({
      path: { listId },
    });
    if (!response.data) {
      throw new Error('Status list not found');
    }
    return response.data;
  }

  /**
   * Create a new status list
   */
  async createList(dto: CreateStatusListDto): Promise<StatusListResponseDto> {
    const response = await statusListManagementControllerCreateList({
      body: dto,
    });
    if (!response.data) {
      throw new Error('Failed to create status list');
    }
    return response.data;
  }

  /**
   * Update a status list
   */
  async updateList(listId: string, dto: UpdateStatusListDto): Promise<StatusListResponseDto> {
    const response = await statusListManagementControllerUpdateList({
      path: { listId },
      body: dto,
    });
    if (!response.data) {
      throw new Error('Failed to update status list');
    }
    return response.data;
  }

  /**
   * Delete a status list
   */
  async deleteList(listId: string): Promise<void> {
    await statusListManagementControllerDeleteList({
      path: { listId },
    });
  }
}
