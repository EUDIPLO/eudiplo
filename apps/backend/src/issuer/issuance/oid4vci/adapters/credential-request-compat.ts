type CredentialResponseEncryptionInput = {
    jwk: Record<string, unknown> & { alg?: string };
    alg?: string;
    [key: string]: unknown;
};

type CredentialRequestEncryptionInput = {
    credential_response_encryption?: CredentialResponseEncryptionInput;
    [key: string]: unknown;
};

/** Add the legacy sibling `alg` expected by older OpenID4VCI parser drafts. */
export function addLegacyCredentialResponseEncryptionAlg<
    T extends CredentialRequestEncryptionInput,
>(request: T): T {
    const encryption = request.credential_response_encryption;
    if (!encryption || encryption.alg || !encryption.jwk.alg) return request;

    return {
        ...request,
        credential_response_encryption: {
            ...encryption,
            alg: encryption.jwk.alg,
        },
    } as T;
}
