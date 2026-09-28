import { INestApplication } from "@nestjs/common";
import {
    clientAuthenticationAnonymous,
    Jwk,
    JwtSignerJwk,
} from "@openid4vc/oauth2";
import { Openid4vciClient } from "@openid4vc/openid4vci";
import { Issuer } from "@owf/mdoc";
import { exportJWK, generateKeyPair } from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    test,
    vi,
} from "vitest";
import { MdocIssuerService } from "../../src/issuer/configuration/credentials/issuer/mdoc-issuer/mdoc-issuer.service.js";
import {
    callbacks,
    getSignJwtCallback,
    IssuanceTestContext,
    setupIssuanceTestApp,
} from "../utils.js";
import { mdocContext } from "../utils-mdoc.js";

function createMdocIssuerService() {
    return new MdocIssuerService({} as any, {} as any, {} as any);
}

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Issuance - mDOC Credentials", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let clientId: string;
    let ctx: IssuanceTestContext;

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        clientId = ctx.clientId;
    });

    afterAll(async () => {
        await app?.close();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test("issue mso_mdoc credential", async () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );

        // Create an offer for mDOC credential
        const offerResponse = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-mdoc-no-key"],
                flow: "pre_authorized_code",
            })
            .expect(201);

        expect(offerResponse.body.uri).toBeDefined();

        // Generate holder key pair
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

        // Resolve credential offer
        const credentialOffer = await client.resolveCredentialOffer(
            offerResponse.body.uri,
        );

        // Resolve issuer metadata
        const issuerMetadata = await client.resolveIssuerMetadata(
            credentialOffer.credential_issuer,
        );

        // Get access token using pre-authorized code
        const { accessTokenResponse } =
            await client.retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            });

        // Request nonce from the nonce endpoint (OID4VCI spec)
        const nonceResponse = await client.requestNonce({ issuerMetadata });
        expect(nonceResponse.c_nonce).toBeDefined();

        //TODO: check if jwt or cose has to be
        // Create JWT proof for credential request
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

        // Retrieve the mDOC credential
        const credentialResponse = await client
            .retrieveCredentials({
                accessToken: accessTokenResponse.access_token,
                credentialConfigurationId:
                    credentialOffer.credential_configuration_ids[0],
                issuerMetadata,
                proofs: {
                    jwt: [proofJwt],
                },
            })
            .catch((error) => {
                console.error("Error retrieving credentials:", error);
                throw error;
            });

        const credential: string = (
            credentialResponse.credentialResponse.credentials?.[0] as any
        ).credential;
        expect(credential).toBeDefined();

        // mDOC credential should be a base64url encoded string
        expect(typeof credential).toBe("string");
        // Verify it's valid base64url (no padding, no + or /)
        expect(credential).toMatch(/^[A-Za-z0-9_-]+$/);

        expect(addNamespaceSpy).toHaveBeenCalledTimes(1);
        expect(addNamespaceSpy).toHaveBeenCalledWith(
            "eu.europa.ec.eudi.pid.1",
            expect.objectContaining({
                age_birth_year: 1964,
                age_over_18: true,
                birth_date: "1964-08-12",
            }),
        );
    });

    test("issue mso_mdoc credential with inline claims from credential offer", async () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );

        // Create an offer for mDOC credential with inline claims override
        const offerResponse = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                response_type: "uri",
                credentialConfigurationIds: ["pid-mdoc-no-key"],
                flow: "pre_authorized_code",
                credentialClaims: {
                    "pid-mdoc-no-key": {
                        type: "inline",
                        claims: {
                            birth_date: "1999-12-31",
                            expiry_date: "2035-01-14",
                            family_name: "OFFER_OVERRIDE",
                            given_name: "ERIKA",
                            issuance_date: "2025-01-14",
                            issuing_authority: "DE",
                            issuing_country: "DE",
                        },
                    },
                },
            })
            .expect(201);

        expect(offerResponse.body.uri).toBeDefined();

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

        const { accessTokenResponse } =
            await client.retrievePreAuthorizedCodeAccessTokenFromOffer({
                credentialOffer,
                issuerMetadata,
            });

        const nonceResponse = await client.requestNonce({ issuerMetadata });
        expect(nonceResponse.c_nonce).toBeDefined();

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
            proofs: {
                jwt: [proofJwt],
            },
        });

        const credential: string = (
            credentialResponse.credentialResponse.credentials?.[0] as any
        ).credential;
        expect(credential).toBeDefined();
        expect(typeof credential).toBe("string");
        expect(credential).toMatch(/^[A-Za-z0-9_-]+$/);

        expect(addNamespaceSpy).toHaveBeenCalledTimes(1);
        expect(addNamespaceSpy).toHaveBeenCalledWith(
            "eu.europa.ec.eudi.pid.1",
            expect.objectContaining({
                birth_date: "1999-12-31",
                family_name: "OFFER_OVERRIDE",
                age_birth_year: 1964,
            }),
        );
    });
});

describe("MdocIssuerService namespace merge behavior", () => {
    const defaultNamespace = "eu.europa.ec.eudi.pid.1";

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test("adds default namespace once when fields and fallback claims overlap", () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );
        const service = createMdocIssuerService() as any;
        const issuer = new Issuer(defaultNamespace, mdocContext);

        service.addClaimsToIssuer(
            issuer,
            [
                {
                    namespace: defaultNamespace,
                    path: ["age_birth_year"],
                    defaultValue: 1964,
                },
                {
                    namespace: defaultNamespace,
                    path: ["age_over_18"],
                    defaultValue: true,
                },
            ],
            defaultNamespace,
            {
                birth_date: "1964-08-12",
            },
        );

        expect(addNamespaceSpy).toHaveBeenCalledTimes(1);
        expect(addNamespaceSpy).toHaveBeenCalledWith(
            defaultNamespace,
            expect.objectContaining({
                age_birth_year: 1964,
                age_over_18: true,
                birth_date: "1964-08-12",
            }),
        );
    });

    test("fallback claims override default values for matching keys", () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );
        const service = createMdocIssuerService() as any;
        const issuer = new Issuer(defaultNamespace, mdocContext);

        service.addClaimsToIssuer(
            issuer,
            [
                {
                    namespace: defaultNamespace,
                    path: ["birth_date"],
                    defaultValue: "1964-08-12",
                },
            ],
            defaultNamespace,
            {
                birth_date: "1999-12-31",
            },
        );

        expect(addNamespaceSpy).toHaveBeenCalledTimes(1);
        expect(addNamespaceSpy).toHaveBeenCalledWith(
            defaultNamespace,
            expect.objectContaining({
                birth_date: "1999-12-31",
            }),
        );
    });

    test("keeps non-default namespaces and enriches only default namespace from fallback claims", () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );
        const service = createMdocIssuerService() as any;
        const issuer = new Issuer(defaultNamespace, mdocContext);
        const altNamespace = "org.iso.18013.5.1";

        service.addClaimsToIssuer(
            issuer,
            [
                {
                    namespace: defaultNamespace,
                    path: ["given_name"],
                    defaultValue: "ERIKA",
                },
                {
                    namespace: altNamespace,
                    path: ["document_number"],
                    defaultValue: "ABCD1234",
                },
            ],
            defaultNamespace,
            {
                family_name: "MUSTERMANN",
            },
        );

        expect(addNamespaceSpy).toHaveBeenCalledTimes(2);
        expect(addNamespaceSpy).toHaveBeenCalledWith(
            defaultNamespace,
            expect.objectContaining({
                given_name: "ERIKA",
                family_name: "MUSTERMANN",
            }),
        );
        expect(addNamespaceSpy).toHaveBeenCalledWith(
            altNamespace,
            expect.objectContaining({
                document_number: "ABCD1234",
            }),
        );
    });

    test("ignores fallback namespace-object key to avoid accidental re-namespacing", () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );
        const service = createMdocIssuerService() as any;
        const issuer = new Issuer(defaultNamespace, mdocContext);

        service.addClaimsToIssuer(
            issuer,
            [
                {
                    namespace: defaultNamespace,
                    path: ["given_name"],
                    defaultValue: "ERIKA",
                },
            ],
            defaultNamespace,
            {
                [defaultNamespace]: {
                    should_not_be_nested: true,
                },
                family_name: "MUSTERMANN",
            },
        );

        expect(addNamespaceSpy).toHaveBeenCalledTimes(1);
        expect(addNamespaceSpy).toHaveBeenCalledWith(
            defaultNamespace,
            expect.objectContaining({
                given_name: "ERIKA",
                family_name: "MUSTERMANN",
            }),
        );

        const namespacePayload = addNamespaceSpy.mock.calls[0]?.[1] as Record<
            string,
            unknown
        >;
        expect(namespacePayload[defaultNamespace]).toBeUndefined();
    });

    test("does not add namespace when both fields and fallback claims are empty", () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );
        const service = createMdocIssuerService() as any;
        const issuer = new Issuer(defaultNamespace, mdocContext);

        service.addClaimsToIssuer(issuer, [], defaultNamespace, {});

        expect(addNamespaceSpy).not.toHaveBeenCalled();
    });
});
