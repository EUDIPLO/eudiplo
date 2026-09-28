import type { SchemaURIMeta } from "@owf/eudi-attestation-schema";
import type { z } from "zod";
import { NotFoundError } from "../../../../shared/domain/not-found-error.js";
import type { CredentialConfigCreateSchema } from "../schemas/credential-config.schema.js";
export type CredentialConfiguration = Omit<
    z.output<typeof CredentialConfigCreateSchema>,
    "schemaMeta" | "embeddedDisclosurePolicy"
> & {
    tenantId: string;
    embeddedDisclosurePolicy?: { policy: string; values?: unknown } | null;
    schemaMeta?: {
        id?: string;
        name?: string;
        version: string;
        rulebookURI?: string;
        attestationLoS:
            | "iso_18045_high"
            | "iso_18045_moderate"
            | "iso_18045_enhanced-basic"
            | "iso_18045_basic";
        bindingType: "claim" | "key" | "biometric" | "none";
        schemaURIs?: Array<{
            credentialConfigId?: string;
            format?: string;
            uri?: string;
            meta?: SchemaURIMeta;
        }>;
        trustedAuthorities?: Array<{
            trustListId?: string;
            frameworkType?: "aki" | "etsi_tl" | "openid_federation" | "x509";
            value?: string;
            verificationMethod?: Record<string, unknown> | string;
        }>;
    } | null;
};
export class CredentialConfigurationNotFound extends NotFoundError {
    constructor(
        readonly tenantId: string,
        readonly configurationId: string,
    ) {
        super(`Credential configuration '${configurationId}' not found`);
        this.name = "CredentialConfigurationNotFound";
    }
}
