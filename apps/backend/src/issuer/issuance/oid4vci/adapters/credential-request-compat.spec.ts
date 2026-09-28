import { describe, expect, it } from "vitest";
import { addLegacyCredentialResponseEncryptionAlg } from "./credential-request-compat.js";

describe("addLegacyCredentialResponseEncryptionAlg", () => {
    it("adds the legacy sibling alg without mutating the wallet request", () => {
        const request = {
            credential_configuration_id: "pid",
            credential_response_encryption: {
                jwk: { kty: "EC", alg: "ECDH-ES" },
                enc: "A256GCM",
            },
        };

        const normalized = addLegacyCredentialResponseEncryptionAlg(request);

        expect(normalized).toEqual({
            ...request,
            credential_response_encryption: {
                ...request.credential_response_encryption,
                alg: "ECDH-ES",
            },
        });
        expect(request.credential_response_encryption).not.toHaveProperty(
            "alg",
        );
    });

    it("preserves an explicit legacy alg and requests without response encryption", () => {
        const legacyRequest = {
            credential_response_encryption: {
                jwk: { kty: "EC", alg: "ECDH-ES" },
                alg: "ECDH-ES+A256KW",
                enc: "A256GCM",
            },
        };
        expect(addLegacyCredentialResponseEncryptionAlg(legacyRequest)).toBe(
            legacyRequest,
        );

        const plainRequest = { credential_configuration_id: "pid" };
        expect(addLegacyCredentialResponseEncryptionAlg(plainRequest)).toBe(
            plainRequest,
        );
    });
});
