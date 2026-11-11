import { describe, expect, it, vi } from "vitest";
import type { EncryptionService } from "../../../../crypto/encryption/encryption.service.js";
import type { CredentialsService } from "../../../configuration/credentials/credentials.service.js";
import { ConfiguredIssuerMetadataSources } from "./configured-issuer-metadata-sources.js";

function sources(publicKey: Record<string, unknown>) {
    return new ConfiguredIssuerMetadataSources(
        {} as CredentialsService,
        {
            getEncryptionPublicKey: vi.fn().mockResolvedValue(publicKey),
        } as unknown as EncryptionService,
    );
}

const publicKey = { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "enc" };

describe("ConfiguredIssuerMetadataSources.credentialRequestEncryptionKey", () => {
    it("advertises ECDH-ES for a key without alg", async () => {
        await expect(
            sources(publicKey).credentialRequestEncryptionKey("tenant"),
        ).resolves.toEqual({ ...publicKey, alg: "ECDH-ES" });
    });

    it("advertises ECDH-ES for a signing key chain with usage type encrypt", async () => {
        await expect(
            sources({
                ...publicKey,
                alg: "ES256",
            }).credentialRequestEncryptionKey("tenant"),
        ).resolves.toMatchObject({ alg: "ECDH-ES" });
    });

    it("rejects a key without kid", async () => {
        const { kid: _kid, ...withoutKid } = publicKey;
        await expect(
            sources(withoutKid).credentialRequestEncryptionKey("tenant"),
        ).rejects.toThrow("has no kty or kid");
    });
});
