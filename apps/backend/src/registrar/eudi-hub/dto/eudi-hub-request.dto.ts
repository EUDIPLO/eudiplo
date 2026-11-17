import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/**
 * Access token of the EUDI Hub portal, with or without the `Bearer ` prefix.
 * Only the characters of an RFC 6750 bearer token are accepted, so the
 * value cannot add a header line.
 */
const EudiHubTokenSchema = z
    .string()
    .trim()
    .transform((value) => value.replace(/^Bearer\s+/i, ""))
    .pipe(
        z
            .string()
            .min(1, "Paste the access token from the EUDI Hub portal.")
            .max(16_384)
            .regex(
                /^[A-Za-z0-9\-._~+/]+=*$/,
                "This is not an access token. Copy the value after 'Bearer ' from the Authorization header of a request the portal sends to the EUDI Hub API.",
            ),
    )
    .describe(
        "Access token of the EUDI Hub portal (the value of the Authorization header the portal sends, with or without 'Bearer '). EUDIPLO uses it for this request only and does not store it.",
    );

const HttpUrlSchema = z.url({ protocol: /^https?$/ }).max(2048);

const OrganizationIdSchema = z
    .uuid()
    .describe("ID of the organization at the EUDI Hub.");

const EnvironmentSchema = z
    .enum(["sandbox", "live"])
    .describe("EUDI Hub environment that issues the certificate.");

export const EudiHubOrganizationsRequestSchema = z
    .object({ token: EudiHubTokenSchema })
    .describe("Payload for listing the EUDI Hub organizations of a token.")
    .strict();

export const EudiHubAccessCertificateRequestSchema = z
    .object({
        token: EudiHubTokenSchema,
        organizationId: OrganizationIdSchema,
        keyId: z
            .string()
            .min(1)
            .describe(
                "Standalone access key chain the certificate is requested for.",
            ),
        environment: EnvironmentSchema,
        supportUri: HttpUrlSchema.describe(
            "Where interested parties can reach the organization for support regarding this certificate.",
        ),
        name: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe(
                "Display name of the certificate at the EUDI Hub. Defaults to the key chain's description or ID.",
            ),
    })
    .describe(
        "Payload for requesting an access certificate from the EUDI Hub for a key chain.",
    )
    .strict();

export type EudiHubAccessCertificateRequest = z.infer<
    typeof EudiHubAccessCertificateRequestSchema
>;

export class EudiHubOrganizationsRequestDto extends createZodDto(
    EudiHubOrganizationsRequestSchema,
) {}

export class EudiHubAccessCertificateRequestDto extends createZodDto(
    EudiHubAccessCertificateRequestSchema,
) {}

/** Texts in German and English, as the EUDI Hub requires, and optionally more languages. */
const BilingualTextSchema = z
    .array(
        z
            .object({
                lang: z
                    .string()
                    .regex(/^[a-z]{2}$/, "Use an ISO 639-1 language code.")
                    .describe("ISO 639-1 language code, such as de or en."),
                content: z.string().trim().min(1).max(2000),
            })
            .strict(),
    )
    .min(2)
    .max(24)
    .refine(
        (texts) => new Set(texts.map(({ lang }) => lang)).size === texts.length,
        "Give each language once.",
    )
    .refine(
        (texts) =>
            ["de", "en"].every((lang) =>
                texts.some((text) => text.lang === lang),
            ),
        "The EUDI Hub needs a German (de) and an English (en) text.",
    );

/** Identifier schemes the EUDI Hub accepts for a legal person. */
const IDENTIFIER_TYPES = [
    "http://data.europa.eu/eudi/id/EUID",
    "http://data.europa.eu/eudi/id/LEI",
    "http://data.europa.eu/eudi/id/EORI-No",
    "http://data.europa.eu/eudi/id/VATIN",
    "http://data.europa.eu/eudi/id/TIN",
    "http://data.europa.eu/eudi/id/Excise",
    "http://data.eudi-hub.de/eudi/id/DatenuebermittlerPseudonymId",
    "http://data.eudi-hub.de/eudi/id/Handelsregisternummer",
] as const;

const RegistrationCertificateBaseSchema = z.object({
    token: EudiHubTokenSchema,
    organizationId: OrganizationIdSchema,
    environment: EnvironmentSchema,
    identifier: z
        .object({
            type: z.enum(IDENTIFIER_TYPES),
            value: z.string().trim().min(1).max(200),
        })
        .strict()
        .describe(
            "Official identifier of the organization to put in the certificate, one of those the EUDI Hub has for it.",
        ),
    serviceDescription: BilingualTextSchema.describe(
        "Description of the service in German and English, shown to wallet users.",
    ),
    supportUri: HttpUrlSchema.describe(
        "Where people can reach the organization about this certificate.",
    ),
    infoUri: HttpUrlSchema.describe("General web address of the organization."),
    name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Display name of the certificate at the EUDI Hub."),
});

const EudiHubOrganizationDetailsRequestSchema = z
    .object({ token: EudiHubTokenSchema, organizationId: OrganizationIdSchema })
    .describe(
        "Payload for reading what the EUDI Hub knows about an organization.",
    )
    .strict();

export const EudiHubPresentationRegistrationCertificateRequestSchema =
    RegistrationCertificateBaseSchema.extend({
        presentationConfigId: z
            .string()
            .min(1)
            .describe(
                "Presentation configuration whose DCQL query the certificate covers and that stores it.",
            ),
        purpose: BilingualTextSchema.describe(
            "Why the data is requested, in German and English (GDPR purpose).",
        ),
        privacyPolicy: HttpUrlSchema.describe("Privacy policy URL."),
    })
        .describe(
            "Payload for requesting a verifier registration certificate from the EUDI Hub.",
        )
        .strict();

export const EudiHubIssuerRegistrationCertificateRequestSchema =
    RegistrationCertificateBaseSchema.describe(
        "Payload for requesting an issuer registration certificate from the EUDI Hub.",
    ).strict();

export type EudiHubPresentationRegistrationCertificateRequest = z.infer<
    typeof EudiHubPresentationRegistrationCertificateRequestSchema
>;
export type EudiHubIssuerRegistrationCertificateRequest = z.infer<
    typeof EudiHubIssuerRegistrationCertificateRequestSchema
>;

export class EudiHubOrganizationDetailsRequestDto extends createZodDto(
    EudiHubOrganizationDetailsRequestSchema,
) {}

export class EudiHubPresentationRegistrationCertificateRequestDto extends createZodDto(
    EudiHubPresentationRegistrationCertificateRequestSchema,
) {}

export class EudiHubIssuerRegistrationCertificateRequestDto extends createZodDto(
    EudiHubIssuerRegistrationCertificateRequestSchema,
) {}
