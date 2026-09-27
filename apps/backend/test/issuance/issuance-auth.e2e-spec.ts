import { INestApplication } from "@nestjs/common";
import {
    clientAuthenticationAnonymous,
    Jwk,
    JwtSignerJwk,
} from "@openid4vc/oauth2";
import {
    extractScopesForCredentialConfigurationIds,
    Openid4vciClient,
} from "@openid4vc/openid4vci";
import { digest } from "@owf/crypto";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import { exportJWK, generateKeyPair } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, fetch, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
    callbacks,
    getSignJwtCallback,
    IssuanceTestContext,
    setupIssuanceTestApp,
} from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Issuance - Authorization Code Flow", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;

    const sdjwt = new SDJwtVcInstance({
        hasher: digest,
        hashAlg: "sha-256",
    });

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        await app.close();
    });

    test("authorized code flow", async () => {
        const offerResponse = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-no-key"],
                flow: "authorization_code",
            })
            .expect(201);

        const holderKeyPair = await generateKeyPair("ES256", {
            extractable: true,
        });
        const holderPrivateKeyJwk = await exportJWK(holderKeyPair.privateKey);
        const holderPublicKeyJwk = await exportJWK(holderKeyPair.publicKey);

        const client = new Openid4vciClient({
            callbacks: {
                ...callbacks,
                clientAuthentication: clientAuthenticationAnonymous(),
                signJwt: getSignJwtCallback([holderPrivateKeyJwk as Jwk]),
            },
        });
        const credentialOffer = await client.resolveCredentialOffer(
            offerResponse.body.uri,
        );

        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );

        const dpopSigner = {
            method: "jwk",
            alg: "ES256",
            publicJwk: holderPublicKeyJwk,
        } as JwtSignerJwk;

        const clientId = "wallet";
        const redirectUri = "http://127.0.0.1:3000/callback";
        const pkceCodeVerifier = "random-code-verifier";

        const { authorizationRequestUrl, pkce } =
            await client.createAuthorizationRequestUrlFromOffer({
                clientId,
                issuerMetadata,
                redirectUri,
                credentialOffer,
                pkceCodeVerifier,
                scope: extractScopesForCredentialConfigurationIds({
                    credentialConfigurationIds:
                        credentialOffer.credential_configuration_ids,
                    issuerMetadata,
                })?.join(" "),
            });
        // Get the authorization code, in this setup it will return a redirect with the URL
        const result = await fetch(authorizationRequestUrl);
        const authorizationCode = new URL(result.url).searchParams.get("code")!;
        const { accessTokenResponse, dpop } =
            await client.retrieveAuthorizationCodeAccessTokenFromOffer({
                issuerMetadata,
                authorizationCode,
                credentialOffer,
                pkceCodeVerifier: pkce?.codeVerifier,
                dpop: {
                    nonce: "random-nonce",
                    signer: dpopSigner,
                },
                redirectUri,
            });

        // Request nonce from the nonce endpoint (OID4VCI spec)
        const nonceResponse = await client.requestNonce({ issuerMetadata });

        const { jwt: proofJwt } = await client.createCredentialRequestJwtProof({
            issuerMetadata,
            signer: {
                method: "jwk",
                alg: "ES256",
                publicJwk: holderPublicKeyJwk,
            } as JwtSignerJwk,
            clientId,
            issuedAt: new Date(),
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            nonce: nonceResponse.c_nonce,
        });

        const credentialResponse = await client.retrieveCredentials({
            accessToken: accessTokenResponse.access_token,
            credentialConfigurationId:
                credentialOffer.credential_configuration_ids[0],
            issuerMetadata,
            dpop: {
                ...dpop,
                signer: dpopSigner,
            },
            proof: {
                proof_type: "jwt",
                jwt: proofJwt,
            },
        });

        const credential: string = (
            credentialResponse.credentialResponse.credentials?.[0] as any
        ).credential;
        expect(credential).toBeDefined();

        const claims: any = await sdjwt.getClaims(credential);

        // exp need to be defined
        expect(claims.exp).toBeDefined();
        // lifetime should be 1 week (604800 seconds); time claims are rounded to the hour
        expect(claims.iat % 3600).toBe(0);
        expect(claims.exp % 3600).toBe(0);
        expect(claims.exp - claims.iat).toBeGreaterThanOrEqual(604800);
        expect(claims.exp - claims.iat).toBeLessThanOrEqual(604800 + 3600);
        // status should be defined
        expect(claims.status).toBeDefined();
        // check that a key is present in the cnf
        expect(claims.cnf).toBeDefined();

        await client.sendNotification({
            issuerMetadata,
            notification: {
                notificationId:
                    credentialResponse.credentialResponse.notification_id!,
                event: "credential_accepted",
            },
            accessToken: accessTokenResponse.access_token,
            dpop: {
                ...dpop,
                signer: dpopSigner,
            },
        });
        const session = await request(app.getHttpServer())
            .get(`/session/${offerResponse.body.session}`)
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`);
        const notificationObj = session.body.notifications.find(
            (notification: any) =>
                notification.id ===
                credentialResponse.credentialResponse.notification_id,
        );
        expect(notificationObj).toBeDefined();
        expect(notificationObj.event).toBe("credential_accepted");
    });
});
