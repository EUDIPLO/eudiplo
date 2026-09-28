import type { RegistrationCertificateRequest } from "../dto/vp-request.dto.js";

/**
 * Flat form fields the management UI may send instead of a nested
 * `registration_cert` object.
 */
type RegistrationCertificateFormFields = {
    registrationCertImportJwt?: string | null;
    registrationCertImportId?: string | null;
    registrationCertBodyPrivacyPolicy?: string | null;
    registrationCertBodySupportUri?: string | null;
    registrationCertBodyIntermediary?: string | null;
    registrationCertBodyPurpose?: Array<{
        lang?: string | null;
        content?: string | null;
    }> | null;
};

const registrationCertificateFormFieldKeys = [
    "registrationCertImportJwt",
    "registrationCertImportId",
    "registrationCertBodyPrivacyPolicy",
    "registrationCertBodySupportUri",
    "registrationCertBodyIntermediary",
    "registrationCertBodyPurpose",
] as const;

/**
 * Converts the flat registration-certificate form fields into a
 * `registration_cert` object (unless one is already present) and strips the
 * form fields from the returned copy.
 */
export function normalizeRegistrationCertFormFields<T extends object>(
    request: T,
): T {
    const normalized = { ...request } as T &
        RegistrationCertificateFormFields & {
            registration_cert?: RegistrationCertificateRequest | null;
        };

    if (
        !Object.prototype.hasOwnProperty.call(normalized, "registration_cert")
    ) {
        const registrationCert =
            buildRegistrationCertFromFormFields(normalized);
        if (registrationCert !== undefined) {
            normalized.registration_cert = registrationCert;
        }
    }

    for (const key of registrationCertificateFormFieldKeys) {
        delete normalized[key];
    }

    return normalized;
}

function buildRegistrationCertFromFormFields(
    fields: RegistrationCertificateFormFields,
): RegistrationCertificateRequest | null | undefined {
    const jwt = trimOptionalString(fields.registrationCertImportJwt);
    if (jwt) {
        return { jwt };
    }

    const id = trimOptionalString(fields.registrationCertImportId);
    if (id) {
        return { id };
    }

    const purpose = (fields.registrationCertBodyPurpose ?? [])
        .map((entry) => ({
            lang: trimOptionalString(entry.lang),
            content: trimOptionalString(entry.content),
        }))
        .filter((entry): entry is { lang: string; content: string } =>
            Boolean(entry.lang && entry.content),
        );

    const body: NonNullable<RegistrationCertificateRequest["body"]> = {};
    const privacyPolicy = trimOptionalString(
        fields.registrationCertBodyPrivacyPolicy,
    );
    const supportUri = trimOptionalString(
        fields.registrationCertBodySupportUri,
    );
    const intermediary = trimOptionalString(
        fields.registrationCertBodyIntermediary,
    );

    if (privacyPolicy) {
        body.privacy_policy = privacyPolicy;
    }
    if (supportUri) {
        body.support_uri = supportUri;
    }
    if (intermediary) {
        body.intermediary = intermediary;
    }
    if (purpose.length > 0) {
        body.purpose = purpose;
    }

    return Object.keys(body).length > 0 ? { body } : undefined;
}

function trimOptionalString(value: string | null | undefined): string {
    return typeof value === "string" ? value.trim() : "";
}
