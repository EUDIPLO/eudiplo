import { z } from "zod";

const RegistrationCertificateDefaultsSchema = z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
        "Optional default values used when generating registration certificates.",
    );

/**
 * The registrar client appends API paths to the registrar URL and the OAuth2
 * client appends OIDC paths to the OIDC URL, so both must be plain http(s)
 * base URLs: a query or fragment would swallow the appended path (for example
 * a trailing `#`), and credentials do not belong in a stored URL. This is a
 * refinement, so the published JSON schema stays unchanged.
 */
function isRegistrarBaseUrl(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === "" &&
        // Checked on the raw value: an empty query or fragment ("?" or "#")
        // is not visible in URL.search or URL.hash.
        !value.includes("?") &&
        !value.includes("#")
    );
}

const REGISTRAR_BASE_URL_MESSAGE =
    "Must be an http(s) URL without query, fragment or credentials";

export const CreateRegistrarConfigSchema = z
    .object({
        registrarUrl: z
            .url()
            .refine(isRegistrarBaseUrl, REGISTRAR_BASE_URL_MESSAGE)
            .describe("Base URL of the registrar service."),
        oidcUrl: z
            .url()
            .refine(isRegistrarBaseUrl, REGISTRAR_BASE_URL_MESSAGE)
            .describe("OIDC discovery or issuer URL used for authentication."),
        clientId: z
            .string()
            .min(1)
            .describe("OAuth client ID used against the registrar."),
        clientSecret: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Optional OAuth client secret for registrar authentication.",
            ),
        username: z
            .string()
            .min(1)
            .describe("Username used for registrar authentication."),
        password: z
            .string()
            .min(1)
            .describe("Password used for registrar authentication."),
        registrationCertificateDefaults:
            RegistrationCertificateDefaultsSchema.describe(
                "Optional default registration certificate values.",
            ),
    })
    .describe("Payload for creating registrar integration settings.")
    .strict();

export const UpdateRegistrarConfigSchema = CreateRegistrarConfigSchema.partial()
    .describe("Payload for partially updating registrar integration settings.")
    .strict();

export const CreateAccessCertificateSchema = z
    .object({
        keyId: z
            .string()
            .min(1)
            .describe("Key chain id used to issue the access certificate."),
    })
    .describe("Payload for creating an access certificate.")
    .strict();

export type CreateRegistrarConfig = z.infer<typeof CreateRegistrarConfigSchema>;
export type UpdateRegistrarConfig = z.infer<typeof UpdateRegistrarConfigSchema>;
export type CreateAccessCertificate = z.infer<
    typeof CreateAccessCertificateSchema
>;
