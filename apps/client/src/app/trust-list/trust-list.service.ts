import { Injectable } from '@angular/core';
import {
  TrustList,
  trustListControllerGetAllTrustLists,
  trustListStatusControllerGetStatus,
  type TrustListStatusResponseDto,
} from '@eudiplo/sdk-core';

@Injectable({
  providedIn: 'root',
})
export class TrustListService {
  async getAll(): Promise<TrustList[]> {
    const response = await trustListControllerGetAllTrustLists();
    return response.data;
  }

  /** How each trust list in use, managed or external, was last loaded. */
  async getStatus(): Promise<TrustListStatusResponseDto[]> {
    const response = await trustListStatusControllerGetStatus();
    return response.data;
  }
}
