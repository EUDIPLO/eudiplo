import { ES256 } from "@owf/crypto";
import { describe, expect, it, vi } from "vitest";
import {
    type FederationResolution,
    FederationResolutionError,
} from "../../../../trust/ports/federation-resolver.js";
import type { VerifierOptions } from "../../../../trust/types.js";
import { SdjwtvcverifierService } from "./sdjwtvcverifier.service.js";

const ISSUER = "https://issuer.example.org";

const b64url = (value: string | ArrayBuffer) =>
    Buffer.from(
        typeof value === "string" ? value : new Uint8Array(value),
    ).toString("base64url");

async function createKey(kid: string) {
    const keys = (await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    const { kty, crv, x, y } = await crypto.subtle.exportKey(
        "jwk",
        keys.publicKey,
    );
    return { privateKey: keys.privateKey, jwk: { kty, crv, x, y, kid } };
}

/** `<b64url(header)>.<b64url(payload)>` and its signature. */
async function sign(
    privateKey: CryptoKey,
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
) {
    const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = b64url(
        await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            privateKey,
            new TextEncoder().encode(data),
        ),
    );
    return { data, signature };
}

function resolutionWith(keys: object[]): FederationResolution {
    return {
        entityId: ISSUER,
        trustAnchor: "https://ta.example.org",
        trustChain: ["ec", "ss", "ta"],
        metadata: { openid_credential_issuer: { jwks: { keys } } },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
}

const OPTIONS: VerifierOptions = {
    federationTrustSource: {
        mode: "federation-only",
        trustAnchors: [
            {
                entityId: "https://ta.example.org",
                entityConfigurationUri:
                    "https://ta.example.org/.well-known/openid-federation",
            },
        ],
    },
    policy: { requireX5c: false },
};

function createService(
    resolveCredentialIssuerKey: (
        issuer: string,
        kid: string,
    ) => Promise<unknown>,
) {
    const federationTrust = {
        resolveCredentialIssuerKey: vi.fn(resolveCredentialIssuerKey),
    };
    const service = new SdjwtvcverifierService(
        {} as any,
        { getCryptoFromJwk: () => ES256 } as any,
        {} as any,
        federationTrust as any,
        {
            setContext: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        } as any,
    );
    const verifyCredential = (data: string, signature: string) =>
        (service as any).verifyFederationCredential(data, signature, OPTIONS);
    const verifyStatusList = (
        data: string,
        signature: string,
        issuer: FederationResolution | undefined,
    ) => (service as any).verifyFederationStatusList(data, signature, issuer);
    return { federationTrust, verifyCredential, verifyStatusList };
}

describe("SdjwtvcverifierService — OpenID Federation", () => {
    it("verifies a credential with the key kid of the issuer's trusted metadata", async () => {
        const key = await createKey("credential-key");
        const resolution = resolutionWith([key.jwk]);
        const { federationTrust, verifyCredential } = createService(
            async () => ({ jwk: key.jwk, resolution }),
        );
        const { data, signature } = await sign(
            key.privateKey,
            { alg: "ES256", typ: "dc+sd-jwt", kid: "credential-key" },
            { iss: ISSUER, vct: "urn:example" },
        );

        await expect(verifyCredential(data, signature)).resolves.toEqual({
            verified: true,
            matchedEntity: null,
            federationIssuer: resolution,
        });
        expect(federationTrust.resolveCredentialIssuerKey).toHaveBeenCalledWith(
            ISSUER,
            "credential-key",
            OPTIONS.federationTrustSource,
        );
    });

    it("rejects a signature by another key under the member's kid", async () => {
        // The key comes from the member's metadata, not from the credential.
        // The E2E test covers an attacker certificate in x5c.
        const member = await createKey("credential-key");
        const attacker = await createKey("credential-key");
        const { verifyCredential } = createService(async () => ({
            jwk: member.jwk,
            resolution: resolutionWith([member.jwk]),
        }));
        const { data, signature } = await sign(
            attacker.privateKey,
            { alg: "ES256", kid: "credential-key" },
            { iss: ISSUER },
        );

        await expect(verifyCredential(data, signature)).resolves.toMatchObject({
            verified: false,
            failureType: "signature_invalid",
        });
    });

    it("rejects a credential without kid", async () => {
        const key = await createKey("credential-key");
        const { federationTrust, verifyCredential } = createService(
            async () => ({ jwk: key.jwk, resolution: resolutionWith([]) }),
        );
        const { data, signature } = await sign(
            key.privateKey,
            { alg: "ES256" },
            { iss: ISSUER },
        );

        await expect(verifyCredential(data, signature)).resolves.toMatchObject({
            verified: false,
            failureType: "verification_error",
        });
        expect(
            federationTrust.resolveCredentialIssuerKey,
        ).not.toHaveBeenCalled();
    });

    it("rejects a credential without iss", async () => {
        const key = await createKey("credential-key");
        const { federationTrust, verifyCredential } = createService(
            async () => ({ jwk: key.jwk, resolution: resolutionWith([]) }),
        );
        const { data, signature } = await sign(
            key.privateKey,
            { alg: "ES256", kid: "credential-key" },
            { vct: "urn:example" },
        );

        await expect(verifyCredential(data, signature)).resolves.toMatchObject({
            verified: false,
            failureType: "verification_error",
        });
        expect(
            federationTrust.resolveCredentialIssuerKey,
        ).not.toHaveBeenCalled();
    });

    it("rejects a header algorithm the trusted key without alg does not use", async () => {
        const key = await createKey("credential-key");
        const { verifyCredential } = createService(async () => ({
            jwk: key.jwk,
            resolution: resolutionWith([key.jwk]),
        }));
        const { data, signature } = await sign(
            key.privateKey,
            { alg: "ES384", kid: "credential-key" },
            { iss: ISSUER },
        );

        await expect(verifyCredential(data, signature)).resolves.toMatchObject({
            verified: false,
            failureType: "signature_invalid",
        });
    });

    it.each([
        ["untrusted", "no_trust_chain_to_root"],
        ["unavailable", "trust_list_unavailable"],
    ] as const)("maps an %s resolution to %s", async (failure, failureType) => {
        const key = await createKey("credential-key");
        const { verifyCredential } = createService(async () => {
            throw new FederationResolutionError("no chain", failure);
        });
        const { data, signature } = await sign(
            key.privateKey,
            { alg: "ES256", kid: "credential-key" },
            { iss: ISSUER },
        );

        await expect(verifyCredential(data, signature)).resolves.toMatchObject({
            verified: false,
            failureType,
        });
    });

    it("rejects a header algorithm that differs from the trusted key", async () => {
        const key = await createKey("credential-key");
        const { verifyCredential } = createService(async () => ({
            jwk: { ...key.jwk, alg: "ES256" },
            resolution: resolutionWith([key.jwk]),
        }));
        const { data, signature } = await sign(
            key.privateKey,
            { alg: "ES384", kid: "credential-key" },
            { iss: ISSUER },
        );

        await expect(verifyCredential(data, signature)).resolves.toMatchObject({
            verified: false,
            failureType: "signature_invalid",
        });
    });

    describe("status list", () => {
        it("accepts a status list signed with a key of the same issuer entity", async () => {
            const statusKey = await createKey("status-key");
            const { verifyStatusList } = createService(vi.fn());
            const { data, signature } = await sign(
                statusKey.privateKey,
                { alg: "ES256", typ: "statuslist+jwt", kid: "status-key" },
                { status_list: { bits: 1, lst: "AA" } },
            );

            await expect(
                verifyStatusList(
                    data,
                    signature,
                    resolutionWith([statusKey.jwk]),
                ),
            ).resolves.toBe(true);
        });

        it("rejects a status list signed with a key the issuer does not list", async () => {
            const credentialKey = await createKey("credential-key");
            const other = await createKey("other-entity-key");
            const { verifyStatusList } = createService(vi.fn());
            const { data, signature } = await sign(
                other.privateKey,
                { alg: "ES256", kid: "other-entity-key" },
                { status_list: { bits: 1, lst: "AA" } },
            );

            await expect(
                verifyStatusList(
                    data,
                    signature,
                    resolutionWith([credentialKey.jwk]),
                ),
            ).resolves.toBe(false);
        });

        it("rejects a status list signed with another key under a listed kid", async () => {
            const statusKey = await createKey("status-key");
            const forged = await createKey("status-key");
            const { verifyStatusList } = createService(vi.fn());
            const { data, signature } = await sign(
                forged.privateKey,
                { alg: "ES256", kid: "status-key" },
                { status_list: { bits: 1, lst: "AA" } },
            );

            await expect(
                verifyStatusList(
                    data,
                    signature,
                    resolutionWith([statusKey.jwk]),
                ),
            ).resolves.toBe(false);
        });

        it("rejects a status list without kid", async () => {
            const statusKey = await createKey("status-key");
            const { verifyStatusList } = createService(vi.fn());
            const { data, signature } = await sign(
                statusKey.privateKey,
                { alg: "ES256" },
                { status_list: { bits: 1, lst: "AA" } },
            );

            await expect(
                verifyStatusList(
                    data,
                    signature,
                    resolutionWith([statusKey.jwk]),
                ),
            ).resolves.toBe(false);
        });

        it("rejects a status list when no issuer entity was resolved", async () => {
            const statusKey = await createKey("status-key");
            const { verifyStatusList } = createService(vi.fn());
            const { data, signature } = await sign(
                statusKey.privateKey,
                { alg: "ES256", kid: "status-key" },
                { status_list: { bits: 1, lst: "AA" } },
            );

            await expect(
                verifyStatusList(data, signature, undefined),
            ).resolves.toBe(false);
        });
    });
});
