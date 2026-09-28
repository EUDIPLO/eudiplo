import type { Role } from "../../roles/role.enum.js";

export interface ClientData {
    clientId: string;
    tenantId?: string | null;
    description?: string | null;
    roles: Role[];
    allowedPresentationConfigs?: string[] | null;
    allowedIssuanceConfigs?: string[] | null;
}

export interface CreatedClient extends ClientData {
    clientSecret?: string;
}
