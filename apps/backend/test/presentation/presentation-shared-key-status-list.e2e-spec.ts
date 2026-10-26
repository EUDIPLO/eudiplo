import "reflect-metadata";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { importJWK } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { KeyChainType } from "../../src/crypto/key/dto/key-chain-create.dto.js";
import { KeyChainService } from "../../src/crypto/key/key-chain.service.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { TrustListCreateDto } from "../../src/issuer/trust-list/dto/trust-list-create.dto.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    preparePresentation,
    setupPresentationTestApp,
} from "../utils.js";
import {
    createCredentialConfigCopy,
    createKeyChain,
    pemChainToX5c,
} from "../utils-ec.js";

/** Fixture key chain that signs the trust list. */
const TRUST_LIST_KEY_CHAIN_ID = "570852d7-7e7f-40af-a0e3-a6ebffd75ed0";

/**
 * An issuer whose attestation and status list key chains were imported with
 * the same private key, as in the demo tenant configuration: each internal
 * chain gets its own self-signed root with the same subject and key. The
 * status list leaf verifies under both roots, and the verifier must still
 * end its path at the revocation root of the trust list entry.
 */
describe("Presentation - status list key chain sharing the issuer key (e2e)", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let statusListService: StatusListService;
    let client: Openid4vpClient;

    const api = () => request(app.getHttpServer());
    const credentialConfigId = "pid-shared-key";
    const requestId = "pid-shared-key-request";
    const trustListId = "shared-key-pid-trust-list";

    let issuerKeyChainId: string;
    let statusKeyChainId: string;

    async function importInternalChain(
        key: JsonWebKey,
        usageType: KeyUsageType,
    ): Promise<string> {
        const response = await api()
            .post("/key-chain/import")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                key,
                usageType,
                type: KeyChainType.InternalChain,
                description: `shared key, ${usageType}`,
            })
            .expect(201);
        return response.body.id;
    }

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        statusListService = ctx.statusListService;
        client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => ctx.host),
            },
        });

        const sharedKey = generateKeyPairSync("ec", {
            namedCurve: "P-256",
        }).privateKey.export({ format: "jwk" });
        const key = { ...sharedKey, alg: "ES256" } as JsonWebKey;
        issuerKeyChainId = await importInternalChain(
            key,
            KeyUsageType.Attestation,
        );
        statusKeyChainId = await importInternalChain(
            key,
            KeyUsageType.StatusList,
        );

        await createCredentialConfigCopy(app, authToken, "pid", {
            id: credentialConfigId,
            keyChainId: issuerKeyChainId,
        });
        await api()
            .post("/status-lists")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                credentialConfigurationId: credentialConfigId,
                keyChainId: statusKeyChainId,
            })
            .expect(201);

        const trustList: TrustListCreateDto = {
            id: trustListId,
            description: "PID issuer with a shared status list key",
            keyChainId: TRUST_LIST_KEY_CHAIN_ID,
            entities: [
                {
                    type: "internal",
                    issuerKeyChainId,
                    revocationKeyChainId: statusKeyChainId,
                    info: { name: "Shared Key PID Provider", lang: "en" },
                },
            ],
        };
        await api()
            .post("/trust-list")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(trustList)
            .expect(201);

        const accessKeyChainId = await createKeyChain(app, authToken, {
            usageType: KeyUsageType.Access,
        });
        await api()
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: requestId,
                description: "PID trusted through the shared-key trust list",
                accessKeyChainId,
                dcql_query: {
                    credentials: [
                        {
                            id: "pid",
                            format: "dc+sd-jwt",
                            meta: {
                                vct_values: [
                                    "<TENANT_URL>/credentials-metadata/vct/pid",
                                ],
                            },
                            trusted_authorities: [
                                {
                                    type: "etsi_tl",
                                    values: [{ trustListId }],
                                },
                            ],
                        },
                    ],
                },
            })
            .expect(201);
    });

    afterAll(async () => {
        await app?.close();
    });

    test("the two key chains have distinct roots with the same subject and key", async () => {
        const keyChains = app.get(KeyChainService);
        const rootOf = async (id: string) => {
            const keyChain = await keyChains.getEntity("root", id);
            const chain = pemChainToX5c(keyChain.activeCertificate);
            return new X509Certificate(Buffer.from(chain.at(-1)!, "base64"));
        };
        const issuerRoot = await rootOf(issuerKeyChainId);
        const statusRoot = await rootOf(statusKeyChainId);

        expect(statusRoot.subject).toBe(issuerRoot.subject);
        expect(statusRoot.publicKey.export({ format: "jwk" })).toEqual(
            issuerRoot.publicKey.export({ format: "jwk" }),
        );
        expect(statusRoot.fingerprint256).not.toBe(issuerRoot.fingerprint256);
    });

    test("verifies a presentation whose status list is signed under the revocation root", async () => {
        const issuer = await app
            .get(KeyChainService)
            .getEntity("root", issuerKeyChainId);
        const issuerKey = (await importJWK(
            issuer.activeJwk,
            "ES256",
        )) as CryptoKey;
        const issuerX5c = pemChainToX5c(issuer.activeCertificate);

        const offer = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId,
        }).expect(201);
        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: offer.body.uri,
        });
        const resolved = await client.resolveOpenId4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });
        const { client_id, nonce } = resolved.authorizationRequestPayload;

        const vpToken = await preparePresentation(
            {
                iat: Math.floor(Date.now() / 1000),
                aud: client_id as string,
                nonce,
            },
            issuerKey,
            issuerX5c,
            statusListService,
            credentialConfigId,
            "shared-key-session",
        );
        const response = await encryptVpToken(vpToken, "pid", resolved);
        const authorizationResponse =
            await client.createOpenid4vpAuthorizationResponse({
                authorizationRequestPayload: authRequest.params,
                authorizationResponsePayload: { response },
                ...callbacks,
            });
        const submitted = await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload:
                authorizationResponse.authorizationResponsePayload,
            authorizationRequestPayload:
                resolved.authorizationRequestPayload as Openid4vpAuthorizationRequest,
        });

        const session = await api()
            .get(`/session/${offer.body.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        expect(session.body.errorReason ?? null).toBeNull();
        expect(submitted.response.status).toBe(200);
        expect(session.body.status).toBe("completed");
    });
});
