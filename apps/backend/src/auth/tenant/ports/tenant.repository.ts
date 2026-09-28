import type { TenantData, TenantUpdate } from "../domain/tenant-data.js";
export const TENANT_REPOSITORY = Symbol("TENANT_REPOSITORY");
export interface TenantRepository {
    count(): Promise<number>;
    list(): Promise<TenantData[]>;
    findActive(id: string): Promise<TenantData | null>;
    findById(id: string): Promise<TenantData | null>;
    getWithClients(id: string): Promise<TenantData>;
    save(tenant: TenantUpdate & { id: string }): Promise<TenantData>;
    update(id: string, data: TenantUpdate): Promise<void>;
    delete(id: string): Promise<void>;
}
