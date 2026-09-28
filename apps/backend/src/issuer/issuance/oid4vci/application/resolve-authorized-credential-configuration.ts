export type CredentialAuthorizationErrorCode =
    | "invalid_credential_request"
    | "unknown_credential_identifier";

export class CredentialAuthorizationError extends Error {
    constructor(
        readonly code: CredentialAuthorizationErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "CredentialAuthorizationError";
    }
}

export interface ResolveAuthorizedCredentialConfigurationInput {
    credentialIdentifier?: string;
    credentialConfigurationId?: string;
    authorizationDetails?: unknown;
}

export class ResolveAuthorizedCredentialConfiguration {
    execute(input: ResolveAuthorizedCredentialConfigurationInput): string {
        const credentialConfigurationId = input.credentialIdentifier
            ? this.resolveIdentifier(
                  input.credentialIdentifier,
                  input.authorizationDetails,
              )
            : input.credentialConfigurationId;

        if (!credentialConfigurationId) {
            throw new CredentialAuthorizationError(
                "invalid_credential_request",
                "Credential configuration identifier is missing",
            );
        }

        this.enforceAuthorizationDetails(
            input.authorizationDetails,
            credentialConfigurationId,
        );
        return credentialConfigurationId;
    }

    private resolveIdentifier(
        credentialIdentifier: string,
        authorizationDetails: unknown,
    ): string {
        const details = Array.isArray(authorizationDetails)
            ? authorizationDetails
            : [];
        const matching = details.find(
            (detail): detail is Record<string, unknown> =>
                typeof detail === "object" &&
                detail !== null &&
                Array.isArray(
                    (detail as Record<string, unknown>).credential_identifiers,
                ) &&
                (
                    (detail as Record<string, unknown>)
                        .credential_identifiers as unknown[]
                ).includes(credentialIdentifier),
        );

        if (
            !matching ||
            typeof matching.credential_configuration_id !== "string"
        ) {
            throw new CredentialAuthorizationError(
                "unknown_credential_identifier",
                `Credential identifier '${credentialIdentifier}' is unknown`,
            );
        }
        return matching.credential_configuration_id;
    }

    private enforceAuthorizationDetails(
        authorizationDetails: unknown,
        requestedCredentialConfigurationId: string,
    ): void {
        if (
            !Array.isArray(authorizationDetails) ||
            authorizationDetails.length === 0
        ) {
            return;
        }

        const authorized = authorizationDetails
            .filter(
                (detail): detail is Record<string, unknown> =>
                    typeof detail === "object" &&
                    detail !== null &&
                    (detail as Record<string, unknown>).type ===
                        "openid_credential",
            )
            .map((detail) => detail.credential_configuration_id)
            .filter((id): id is string => typeof id === "string");

        if (authorized.length === 0) {
            throw new CredentialAuthorizationError(
                "invalid_credential_request",
                "Access token is not authorized for any credential configuration",
            );
        }
        if (!authorized.includes(requestedCredentialConfigurationId)) {
            throw new CredentialAuthorizationError(
                "invalid_credential_request",
                `Access token is not authorized for credential_configuration_id '${requestedCredentialConfigurationId}'`,
            );
        }
    }
}
