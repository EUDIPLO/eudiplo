import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { clientAuthenticationAnonymous, type Jwk } from "@openid4vc/oauth2";
import { Openid4vciClient } from "@openid4vc/openid4vci";
import {
    decodeProtectedHeader,
    exportJWK,
    generateKeyPair,
    importJWK,
    jwtVerify,
} from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { DataSource } from "typeorm";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { IssuanceConfig } from "../../src/issuer/configuration/issuance/entities/issuance-config.entity.js";
import {
    callbacks,
    getSignJwtCallback,
    IssuanceTestContext,
    setupIssuanceTestApp,
} from "../utils.js";

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));

const ATTESTATION_KEY_CHAIN = "c3f24b6e-9b71-4b62-8d37-5f1a2c9e47ad";
const ACCESS_KEY_CHAIN = "2f71c235-87e2-43c9-b572-739a3164ce95";

describe("Access token key chain", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app?.close();
    });

    const jwks = async () =>
        (
            await request(app.getHttpServer())
                .get("/.well-known/jwks.json/issuers/root")
                .expect(200)
        ).body.keys as Jwk[];

    const keyChains = async (usageType?: string) =>
        (
            await request(app.getHttpServer())
                .get("/key-chain")
                .query(usageType ? { usageType } : {})
                .set("Authorization", `Bearer ${authToken}`)
                .expect(200)
        ).body as Array<{
            id: string;
            usageType: string;
            activePublicKey: Jwk;
        }>;

    async function preAuthorizedAccessToken(): Promise<string> {
        const offer = await request(app.getHttpServer())
            .post("/issuer/offer")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
            })
            .expect(201);
        const holder = await generateKeyPair("ES256", { extractable: true });
        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
                signJwt: getSignJwtCallback([
                    (await exportJWK(holder.privateKey)) as Jwk,
                ]),
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
        return accessTokenResponse.access_token;
    }

    test("signs access tokens with an access token key chain EUDIPLO creates, never the access certificate or a credential key", async () => {
        // The tenant has access, attestation, status and trust list key
        // chains, but no access token key chain yet. The public JWKS does
        // not create one.
        expect(await keyChains("accessToken")).toEqual([]);
        expect(await jwks()).toEqual([]);
        expect(await keyChains("accessToken")).toEqual([]);

        const accessToken = await preAuthorizedAccessToken();

        const [created] = await keyChains("accessToken");
        expect(created.id).toBe("access-token");
        const header = decodeProtectedHeader(accessToken);
        expect(header.kid).toBe(created.activePublicKey.kid);

        const published = await jwks();
        expect(published.map((key) => key.kid)).toEqual([
            created.activePublicKey.kid,
        ]);
        const otherKids = (await keyChains())
            .filter((keyChain) => keyChain.usageType !== "accessToken")
            .map((keyChain) => keyChain.activePublicKey.kid);
        expect(otherKids).not.toContain(header.kid);
        await expect(
            jwtVerify(accessToken, await importJWK(published[0], header.alg), {
                clockTolerance: 5,
            }),
        ).resolves.toBeDefined();
    });

    test("keeps the previous key in the JWKS after a rotation", async () => {
        const [before] = await keyChains("accessToken");

        await request(app.getHttpServer())
            .post(`/key-chain/${before.id}/rotate`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(204);

        const [after] = await keyChains("accessToken");
        expect(after.activePublicKey.kid).not.toBe(before.activePublicKey.kid);
        // Tokens signed before the rotation stay valid for their lifetime.
        expect((await jwks()).map((key) => key.kid)).toEqual([
            after.activePublicKey.kid,
            before.activePublicKey.kid,
        ]);
        expect(
            decodeProtectedHeader(await preAuthorizedAccessToken()).kid,
        ).toBe(after.activePublicKey.kid);
    });

    test.each([
        ["an attestation", ATTESTATION_KEY_CHAIN],
        ["an access", ACCESS_KEY_CHAIN],
    ])("refuses %s key chain as token.signingKeyId", async (_, keyChainId) => {
        const response = await request(app.getHttpServer())
            .post("/issuer/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                authorizationServers: [
                    {
                        type: "built-in",
                        id: "issuer-built-in",
                        token: { signingKeyId: keyChainId },
                    },
                ],
            })
            .expect(400);

        expect(response.body.message).toContain(
            'needs a key chain with usage type "accessToken"',
        );
    });

    test("uses the access token key chain an authorization server names", async () => {
        const created = await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ usageType: "accessToken", type: "standalone" })
            .expect(201);
        const keyChainId: string = created.body.id;

        // Fields left out keep their stored values.
        await request(app.getHttpServer())
            .post("/issuer/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                authorizationServers: [
                    {
                        type: "built-in",
                        id: "issuer-built-in",
                        token: { signingKeyId: keyChainId },
                    },
                ],
            })
            .expect(201);

        const named = (await keyChains("accessToken")).find(
            (keyChain) => keyChain.id === keyChainId,
        )!;
        expect(
            decodeProtectedHeader(await preAuthorizedAccessToken()).kid,
        ).toBe(named.activePublicKey.kid);
        expect((await jwks()).map((key) => key.kid)).toEqual([
            named.activePublicKey.kid,
        ]);
    });

    // Last: it leaves the tenant's built-in authorization server broken.
    test("fails token requests with a server error for a key chain stored before the check", async () => {
        // 9.x stored any signing key chain; only the API refuses new ones.
        const issuanceConfigs = app
            .get(DataSource)
            .getRepository(IssuanceConfig);
        await issuanceConfigs.update(
            { tenantId: "root" },
            {
                authorizationServers: [
                    {
                        type: "built-in",
                        id: "issuer-built-in",
                        token: { signingKeyId: ATTESTATION_KEY_CHAIN },
                    },
                ] as IssuanceConfig["authorizationServers"],
            },
        );
        const offer = await request(app.getHttpServer())
            .post("/issuer/offer")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "pre_authorized_code",
            })
            .expect(201);
        const credentialOffer = await new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
            },
        }).resolveCredentialOffer(offer.body.uri);
        const code =
            credentialOffer.grants?.[
                "urn:ietf:params:oauth:grant-type:pre-authorized_code"
            ]?.["pre-authorized_code"];

        const response = await request(app.getHttpServer())
            .post("/issuers/root/authorize/token")
            .type("form")
            .send({
                grant_type:
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code",
                "pre-authorized_code": code!,
            })
            .expect(500);

        // The wallet learns nothing about the tenant's key chains.
        expect(JSON.stringify(response.body)).not.toContain(
            ATTESTATION_KEY_CHAIN,
        );
    });
});
