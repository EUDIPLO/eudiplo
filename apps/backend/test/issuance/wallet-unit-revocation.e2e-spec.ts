import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import {
    clientAuthenticationAnonymous,
    Jwk,
    JwtSignerJwk,
} from "@openid4vc/oauth2";
import {
    createKeyAttestationJwt,
    Openid4vciClient,
    type Openid4vciRetrieveCredentialsError,
} from "@openid4vc/openid4vci";
import { StatusList } from "@owf/token-status-list";
import { X509Certificate } from "@peculiar/x509";
import {
    decodeJwt,
    decodeProtectedHeader,
    exportJWK,
    generateKeyPair,
    importPKCS8,
    SignJWT,
} from "jose";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import { DataSource } from "typeorm";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { CredentialWalletUnit } from "../../src/issuer/status-list/entities/credential-wallet-unit.entity.js";
import { StatusListEntity } from "../../src/issuer/status-list/entities/status-list.entity.js";
import { WalletUnitStatusCheckJob } from "../../src/issuer/wallet-unit-revocation/adapters/wallet-unit-status-check.job.js";
import { StatusListVerifierService } from "../../src/trust/status-list-verifier.service.js";
import {
    callbacks,
    getSignJwtCallback,
    IssuanceTestContext,
    setupIssuanceTestApp,
} from "../utils.js";
import { configureTrustedAttestationProvider } from "./attestation-trust-helpers.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

const HOST = "http://localhost:8787";
const STATUS_PATH = "/wua-status";
const STATUS_URI = `${HOST}${STATUS_PATH}`;
const WALLET_UNIT_IDX = 5;

type Signer = { certificate: X509Certificate; privateKey: CryptoKey };

async function signingKey(signer: Signer) {
    const pkcs8 = await globalThis.crypto.subtle.exportKey(
        "pkcs8",
        signer.privateKey,
    );
    return importPKCS8(
        `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----`,
        "ES256",
    );
}

/** A status list of the wallet provider, signed under its attestation certificate. */
async function walletUnitStatusList(signer: Signer, revoked: boolean) {
    const elements = new Array(16).fill(0);
    elements[WALLET_UNIT_IDX] = revoked ? 1 : 0;
    const lst = Buffer.from(
        new StatusList(elements, 1).compressStatusListToBytes(),
    ).toString("base64url");
    return new SignJWT({
        sub: STATUS_URI,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ttl: 300,
        status_list: { bits: 1, lst },
    })
        .setProtectedHeader({
            alg: "ES256",
            typ: "statuslist+jwt",
            x5c: [signer.certificate.toString("base64")],
        })
        .sign(await signingKey(signer));
}

function serveStatusList(jwt: string) {
    nock(HOST).persist().get(STATUS_PATH).reply(200, jwt, {
        "Content-Type": "application/statuslist+jwt",
    });
}

describe("Issuance - revocation with the wallet unit", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;
    let provider: Signer & { publicKey: CryptoKey };
    let restore: () => Promise<unknown>;
    const configId = `pid-wallet-unit-${Date.now()}`;
    /** Requires key attestations, but does not follow the wallet unit. */
    const plainConfigId = `pid-key-attestation-${Date.now()}`;

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;

        await request(app.getHttpServer())
            .post("/issuer/webhook-endpoints")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "wallet-unit-events",
                name: "Wallet unit events",
                url: `${HOST}/revoked`,
                auth: { type: "none" },
            })
            .expect(201);

        const base = await request(app.getHttpServer())
            .get("/issuer/credentials/pid-no-key")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        const { tenantId: _tenantId, tenant: _tenant, ...config } = base.body;
        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...config,
                id: configId,
                statusManagement: true,
                revokeWithWalletUnit: true,
                webhookEndpointId: "wallet-unit-events",
                config: {
                    ...config.config,
                    proofTypesSupported: ["attestation", "jwt"],
                    keyAttestationsRequired: {},
                },
            })
            .expect(201);
        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...config,
                id: plainConfigId,
                statusManagement: true,
                config: {
                    ...config.config,
                    proofTypesSupported: ["attestation", "jwt"],
                    keyAttestationsRequired: {},
                },
            })
            .expect(201);
    });

    afterEach(async () => {
        nock.cleanAll();
        app.get(StatusListVerifierService).clearCache();
        await restore?.();
    });

    afterAll(async () => {
        for (const id of [configId, plainConfigId]) {
            await request(app.getHttpServer())
                .delete(`/issuer/credentials/${id}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`);
        }
        await app?.close();
    });

    async function issue(
        proofType: "attestation" | "jwt" = "attestation",
        credentialConfigurationId = configId,
    ): Promise<{ sessionId: string; credential: string }> {
        const offer = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: [credentialConfigurationId],
                flow: "pre_authorized_code",
                reference: "order-4711",
            })
            .expect(201);

        const providerPrivateJwk = await exportJWK(provider.privateKey);
        const providerPublicJwk = await exportJWK(provider.publicKey);
        const holder = await generateKeyPair("ES256", { extractable: true });
        const holderPublicJwk = await exportJWK(holder.publicKey);
        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
            },
        });
        const credentialOffer = await client.resolveCredentialOffer(
            offer.body.uri,
        );
        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );
        const { accessTokenResponse } =
            await client.retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            });
        const { c_nonce } = await client.requestNonce({ issuerMetadata });
        const attestation = await createKeyAttestationJwt({
            callbacks: {
                ...callbacks,
                signJwt: getSignJwtCallback([providerPrivateJwk as Jwk]),
            },
            signer: {
                method: "jwk",
                alg: "ES256",
                publicJwk: providerPublicJwk,
            } as JwtSignerJwk,
            issuedAt: new Date(),
            expiresAt: new Date(Date.now() + 300_000),
            use:
                proofType === "jwt"
                    ? "proof_type.jwt"
                    : "proof_type.attestation",
            attestedKeys: [holderPublicJwk as Jwk],
            nonce: c_nonce,
        });
        // The wallet unit attestation: the key attestation with a status
        // list entry and the provider's certificate.
        const walletUnitAttestation = await new SignJWT({
            ...decodeJwt(attestation),
            status: { status_list: { uri: STATUS_URI, idx: WALLET_UNIT_IDX } },
        })
            .setProtectedHeader({
                ...decodeProtectedHeader(attestation),
                x5c: [provider.certificate.toString("base64")],
            })
            .sign(await signingKey(provider));

        const response = await client.retrieveCredentials({
            accessToken: accessTokenResponse.access_token,
            credentialConfigurationId,
            issuerMetadata,
            proofs:
                proofType === "jwt"
                    ? {
                          jwt: [
                              await new SignJWT({ nonce: c_nonce })
                                  .setProtectedHeader({
                                      alg: "ES256",
                                      typ: "openid4vci-proof+jwt",
                                      jwk: holderPublicJwk,
                                      key_attestation: walletUnitAttestation,
                                  })
                                  .setAudience(
                                      credentialOffer.credential_issuer,
                                  )
                                  .setIssuedAt()
                                  .sign(holder.privateKey),
                          ],
                      }
                    : { attestation: [walletUnitAttestation] },
        });
        const credential = response.credentialResponse.credentials?.[0]
            ?.credential as string;
        return { sessionId: offer.body.session, credential };
    }

    async function credentialStatus(credential: string): Promise<number> {
        const { idx, uri } = (
            decodeJwt(credential.split("~")[0]) as {
                status: { status_list: { idx: number; uri: string } };
            }
        ).status.status_list;
        const list = await app
            .get(DataSource)
            .getRepository(StatusListEntity)
            .findOneByOrFail({ id: uri.split("/").at(-1)! });
        return list.elements[idx];
    }

    async function useTrustedProvider() {
        const trust = await configureTrustedAttestationProvider(app, authToken);
        provider = trust.provider;
        restore = trust.restore;
    }

    test("revokes the credential once the wallet unit is revoked and tells the webhook", async () => {
        await useTrustedProvider();
        serveStatusList(await walletUnitStatusList(provider, false));
        const { sessionId, credential } = await issue();

        const records = app.get(DataSource).getRepository(CredentialWalletUnit);
        const { exp } = decodeJwt(credential.split("~")[0]);
        expect(await records.findBy({ sessionId })).toEqual([
            expect.objectContaining({
                credentialConfigurationId: configId,
                walletUnitStatusUri: STATUS_URI,
                walletUnitStatusIdx: WALLET_UNIT_IDX,
                // The check ends when the credential expires.
                credentialExpiresAt: exp ? new Date(exp * 1000) : null,
            }),
        ]);

        // Still valid: nothing changes.
        await app.get(WalletUnitStatusCheckJob).run();
        expect(await credentialStatus(credential)).toBe(0);

        // The provider revokes the wallet unit.
        nock.cleanAll();
        app.get(StatusListVerifierService).clearCache();
        serveStatusList(await walletUnitStatusList(provider, true));
        let delivered: Record<string, unknown> | undefined;
        const webhook = nock(HOST)
            .post("/revoked", (body) => {
                delivered = body;
                return true;
            })
            .reply(200);

        await app.get(WalletUnitStatusCheckJob).run();

        expect(await credentialStatus(credential)).toBe(1);
        expect(webhook.isDone()).toBe(true);
        expect(delivered).toEqual({
            status: "revoked",
            reason: "wallet_unit_revoked",
            session: sessionId,
            reference: "order-4711",
            credentialConfigurationId: configId,
            statusEntries: [
                expect.objectContaining({ idx: expect.any(Number) }),
            ],
        });
        expect(await records.findBy({ sessionId })).toEqual([]);
    });

    test("records the wallet unit of a jwt proof's key attestation", async () => {
        await useTrustedProvider();
        serveStatusList(await walletUnitStatusList(provider, false));
        const { sessionId } = await issue("jwt");

        expect(
            await app
                .get(DataSource)
                .getRepository(CredentialWalletUnit)
                .findBy({ sessionId }),
        ).toEqual([
            expect.objectContaining({ walletUnitStatusIdx: WALLET_UNIT_IDX }),
        ]);
    });

    test.each(["attestation", "jwt"] as const)(
        "issues nothing for a wallet unit that is already revoked (%s)",
        async (proofType) => {
            await useTrustedProvider();
            serveStatusList(await walletUnitStatusList(provider, true));

            const error = await issue(proofType).then(
                () => {
                    throw new Error("Expected the credential request to fail");
                },
                (e: Openid4vciRetrieveCredentialsError) =>
                    e.response.credentialErrorResponseResult?.data,
            );
            expect(error).toEqual({
                error: "invalid_proof",
                error_description:
                    "Key attestation is not valid: Invalid/Revoked",
            });
        },
    );

    test("stops following the wallet unit once the configuration turns it off", async () => {
        await useTrustedProvider();
        serveStatusList(await walletUnitStatusList(provider, false));
        const { sessionId, credential } = await issue();
        await request(app.getHttpServer())
            .patch(`/issuer/credentials/${configId}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({ revokeWithWalletUnit: false })
            .expect(200);
        try {
            nock.cleanAll();
            app.get(StatusListVerifierService).clearCache();
            serveStatusList(await walletUnitStatusList(provider, true));

            await app.get(WalletUnitStatusCheckJob).run();

            expect(await credentialStatus(credential)).toBe(0);
            expect(
                await app
                    .get(DataSource)
                    .getRepository(CredentialWalletUnit)
                    .findBy({ sessionId }),
            ).toEqual([]);
        } finally {
            await request(app.getHttpServer())
                .patch(`/issuer/credentials/${configId}`)
                .trustLocalhost()
                .set("Authorization", `Bearer ${authToken}`)
                .send({ revokeWithWalletUnit: true })
                .expect(200);
        }
    });

    test("checks the key attestation of every configuration, but records only those that follow the wallet unit", async () => {
        await useTrustedProvider();
        serveStatusList(await walletUnitStatusList(provider, false));
        const { sessionId } = await issue("attestation", plainConfigId);
        expect(
            await app
                .get(DataSource)
                .getRepository(CredentialWalletUnit)
                .findBy({ sessionId }),
        ).toEqual([]);

        nock.cleanAll();
        app.get(StatusListVerifierService).clearCache();
        serveStatusList(await walletUnitStatusList(provider, true));
        const error = await issue("attestation", plainConfigId).then(
            () => {
                throw new Error("Expected the credential request to fail");
            },
            (e: Openid4vciRetrieveCredentialsError) =>
                e.response.credentialErrorResponseResult?.data,
        );
        expect(error).toMatchObject({ error: "invalid_proof" });
    });
});
