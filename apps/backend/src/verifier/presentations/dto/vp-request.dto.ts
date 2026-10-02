import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const RegistrationCertificatePurposeSchema = z
    .object({
        lang: z.string(),
        content: z.string(),
    })
    .strict();

const RegistrationCertificateBodySchema = z
    .object({
        privacy_policy: z.string().optional(),
        support_uri: z.string().optional(),
        intermediary: z.string().optional(),
        purpose: z.array(RegistrationCertificatePurposeSchema).optional(),
        credentials: z.array(z.record(z.string(), z.unknown())).optional(),
        // Named and typed as in the registrar's RegistrationCertificateCreation.
        provides_attestations: z.array(z.string().min(1)).optional(),
    })
    .strict();

export const RegistrationCertificateRequestSchema = z
    .object({
        id: z.string().optional(),
        body: RegistrationCertificateBodySchema.optional(),
        jwt: z.string().optional(),
    })
    .strict();

export class RegistrationCertificatePurpose extends createZodDto(
    RegistrationCertificatePurposeSchema,
) {
    lang!: string;

    content!: string;
}

export class RegistrationCertificateBody extends createZodDto(
    RegistrationCertificateBodySchema,
) {
    privacy_policy?: string;

    support_uri?: string;

    intermediary?: string;

    purpose?: RegistrationCertificatePurpose[];

    credentials?: Record<string, unknown>[];

    /**
     * Credential type identifiers (SD-JWT VC `vct` or mdoc doctype) provided
     * by an issuer.
     */
    provides_attestations?: string[];
}

/**
 * RegistrationCertificateRequest DTO
 */
export class RegistrationCertificateRequest extends createZodDto(
    RegistrationCertificateRequestSchema,
) {
    /**
     * Optional registrar-side certificate identifier.
     * If provided and still valid, EUDIPLO reuses it instead of creating a new certificate.
     */
    id?: string;

    /**
     * Registration certificate creation payload.
     * This is merged with tenant-level registrar defaults when a certificate is created.
     */
    body?: RegistrationCertificateBody;

    /**
     * Optional pre-existing registration certificate JWT.
     * If provided, EUDIPLO forwards it as-is and does not create a new one.
     */
    jwt?: string;
}
