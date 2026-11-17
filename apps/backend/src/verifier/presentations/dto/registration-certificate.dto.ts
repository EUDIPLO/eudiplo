import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const RegistrationCertificatePurposeSchema = z
    .object({
        lang: z
            .string()
            .min(1)
            .describe("Language of the text, an ISO 639-1 code such as en."),
        content: z.string().min(1).describe("The purpose in that language."),
    })
    .strict();

/**
 * The registration certificate of a presentation configuration and the
 * values it was requested with. A registrar such as the EUDI Hub issues the
 * certificate; the purpose and privacy policy are kept next to it, so a new
 * certificate can be requested with the same values when it expires or the
 * DCQL query changes, without reading them back from the old JWT.
 */
export const PresentationRegistrationCertificateSchema = z
    .object({
        jwt: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Registration certificate JWT issued by a registrar. Attached to every request object as is; it must be valid and authorize every credential the DCQL query requests.",
            ),
        purpose: z
            .array(RegistrationCertificatePurposeSchema)
            .optional()
            .describe(
                "Why the data is requested (GDPR purpose), one text per language. Used when a certificate is requested from a registrar.",
            ),
        privacy_policy: z
            .string()
            .min(1)
            .optional()
            .describe(
                "URL of the privacy policy that applies to this request. Used when a certificate is requested from a registrar.",
            ),
    })
    .strict();

export class RegistrationCertificatePurpose extends createZodDto(
    RegistrationCertificatePurposeSchema,
) {
    lang!: string;

    content!: string;
}

/**
 * Registration certificate of a presentation configuration: the JWT from a
 * registrar and the purpose and privacy policy it was requested with.
 */
export class PresentationRegistrationCertificate extends createZodDto(
    PresentationRegistrationCertificateSchema,
) {
    /**
     * Registration certificate JWT issued by a registrar, attached to every
     * request object.
     */
    jwt?: string;

    /**
     * Why the data is requested, one text per language. Kept for requesting
     * a new certificate.
     */
    purpose?: RegistrationCertificatePurpose[];

    /**
     * Privacy policy URL that applies to this request. Kept for requesting a
     * new certificate.
     */
    privacy_policy?: string;
}
