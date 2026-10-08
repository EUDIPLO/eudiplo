import type { z } from "zod";
import { NotFoundError } from "../../../../shared/domain/not-found-error.js";
import type { IssuanceConfigSchema } from "../schemas/issuance.schema.js";

type ConfigInput = z.output<typeof IssuanceConfigSchema>;
export interface ManagedAuthorizationServerData {
    type: "external" | "oid4vp" | "chained" | "built-in";
    id: string;
    label?: string;
    enabled?: boolean;
}
export type IssuanceConfiguration = Omit<
    ConfigInput,
    "authorizationServers" | "walletProviderTrustLists" | "display"
> & {
    authorizationServers: ManagedAuthorizationServerData[];
    walletProviderTrustLists?: Array<{
        trustListId?: string;
        url: string;
        verifierKey?: Record<string, unknown>;
        verifierKeyPem?: string;
        verifierX509Der?: string;
    }>;
    display: NonNullable<ConfigInput["display"]>;
    tenantId: string;
    createdAt: Date;
    updatedAt: Date;
    registrationCertificateCache?: {
        jwt: string;
        fingerprint: string;
        issuedAt?: number;
        expiresAt?: number;
    } | null;
};
export class IssuanceConfigurationNotFound extends NotFoundError {
    constructor(readonly tenantId: string) {
        super(`Issuance configuration for tenant '${tenantId}' not found`);
        this.name = "IssuanceConfigurationNotFound";
    }
}
