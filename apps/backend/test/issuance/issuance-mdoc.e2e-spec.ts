import { INestApplication } from "@nestjs/common";
import { clientAuthenticationAnonymous } from "@openid4vc/oauth2";
import { Openid4vciClient } from "@openid4vc/openid4vci";
import { Jwk, type JwsSignerJwk } from "@owf/jose";
import { DateOnly, Issuer, IssuerSigned } from "@owf/mdoc";
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
import { SIGNING_ALG_SPECS } from "../../src/crypto/key/domain/signing-algs.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import { MdocIssuerService } from "../../src/issuer/configuration/credentials/issuer/mdoc-issuer/mdoc-issuer.service.js";
import {
    buildClaimsMetadata,
    mdocDefaultNamespace,
} from "../../src/issuer/configuration/credentials/utils/derive.js";
import {
    callbacks,
    getSignJwsCallback,
    IssuanceTestContext,
    setupIssuanceTestApp,
} from "../utils.js";
import {
    createCredentialConfigCopy,
    createKeyChain,
    credentialConfigurationMetadata,
    deleteKeyChain,
    expectCoseSign1SignedWithX5chain,
} from "../utils-ec.js";
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
                signJws: getSignJwsCallback([holderPrivateKeyJwk as Jwk]),
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
            } as JwsSignerJwk,
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
                birth_date: new DateOnly("1964-08-12"),
            }),
        );

        // The PID Rulebook's date elements are full-date (CBOR tag 1004).
        const issued = IssuerSigned.fromEncodedForOid4Vci(
            credential,
        ).getPrettyClaims("eu.europa.ec.eudi.pid.1")!;
        for (const element of ["birth_date", "issuance_date", "expiry_date"]) {
            expect(issued[element]).toBeInstanceOf(DateOnly);
        }
        expect(String(issued.birth_date)).toBe("1964-08-12");
        expect(issued.family_name).toBeTypeOf("string");
    });

    test.each(["ES384", "ES512"] as const)(
        "signs the IssuerAuth with the algorithm of an %s key chain",
        async (alg) => {
            const keyChainId = await createKeyChain(app, authToken, {
                usageType: KeyUsageType.Attestation,
                alg,
            });
            const configId = `pid-mdoc-${alg}-${Date.now()}`;
            let deleteConfig: (() => Promise<void>) | undefined;

            try {
                deleteConfig = await createCredentialConfigCopy(
                    app,
                    authToken,
                    "pid-mdoc-no-key",
                    { id: configId, keyChainId },
                );
                const metadata = await credentialConfigurationMetadata(
                    app,
                    configId,
                );
                // The classic COSE id; a fully-specified one may follow it.
                expect(
                    metadata.credential_signing_alg_values_supported,
                ).toContain(SIGNING_ALG_SPECS[alg].coseAlg);
                expect(
                    metadata.credential_signing_alg_values_supported,
                ).not.toContain(SIGNING_ALG_SPECS.ES256.coseAlg);

                const offerResponse = await request(app.getHttpServer())
                    .post("/issuer/offer")
                    .trustLocalhost()
                    .set("Authorization", `Bearer ${authToken}`)
                    .send({
                        response_type: "uri",
                        credentialConfigurationIds: [configId],
                        flow: "pre_authorized_code",
                    })
                    .expect(201);
                // The device key is on the same curve as the issuer key.
                const holderKeyPair = await generateKeyPair(alg, {
                    extractable: true,
                });
                const holderPublicKeyJwk = await exportJWK(
                    holderKeyPair.publicKey,
                );
                const client = new Openid4vciClient({
                    callbacks: {
                        ...callbacks,
                        clientAuthentication: clientAuthenticationAnonymous(),
                        signJws: getSignJwsCallback([
                            (await exportJWK(holderKeyPair.privateKey)) as Jwk,
                        ]),
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
                const { c_nonce } = await client.requestNonce({
                    issuerMetadata,
                });
                const { jwt: proofJwt } =
                    await client.createCredentialRequestJwtProof({
                        issuerMetadata,
                        signer: {
                            method: "jwk",
                            alg,
                            publicJwk: holderPublicKeyJwk,
                        } as JwsSignerJwk,
                        clientId,
                        issuedAt: new Date(),
                        credentialConfigurationId: configId,
                        nonce: c_nonce,
                    });
                const credentialResponse = await client.retrieveCredentials({
                    accessToken: accessTokenResponse.access_token,
                    credentialConfigurationId: configId,
                    issuerMetadata,
                    proofs: { jwt: [proofJwt] },
                });
                const credential: string = (
                    credentialResponse.credentialResponse
                        .credentials?.[0] as any
                ).credential;

                const issuerSigned =
                    IssuerSigned.fromEncodedForOid4Vci(credential);
                expectCoseSign1SignedWithX5chain(issuerSigned.issuerAuth, alg);
            } finally {
                await deleteConfig?.();
                await deleteKeyChain(app, authToken, keyChainId);
            }
        },
    );

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
                signJws: getSignJwsCallback([holderPrivateKeyJwk as Jwk]),
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
            } as JwsSignerJwk,
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
                birth_date: new DateOnly("1999-12-31"),
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

    test("issues child defaults inside the namespace of their parent", () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );
        const service = createMdocIssuerService() as any;
        const issuer = new Issuer(defaultNamespace, mdocContext);
        const parentNamespace = "org.example.place";

        service.addClaimsToIssuer(
            issuer,
            [
                {
                    namespace: parentNamespace,
                    path: ["place_of_birth"],
                    type: "object",
                    children: [
                        {
                            path: ["locality"],
                            type: "string",
                            defaultValue: "BERLIN",
                        },
                        {
                            path: ["date"],
                            type: "string",
                            format: "date",
                            defaultValue: "1964-08-12",
                        },
                    ],
                },
            ],
            defaultNamespace,
            {},
        );

        expect(addNamespaceSpy).toHaveBeenCalledTimes(1);
        expect(addNamespaceSpy).toHaveBeenCalledWith(parentNamespace, {
            place_of_birth: {
                locality: "BERLIN",
                date: new DateOnly("1964-08-12"),
            },
        });
    });

    test("issues fields without a namespace in the namespace their metadata names", () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );
        const service = createMdocIssuerService() as any;
        const docType = "org.iso.18013.5.1.mDL";
        const mdlNamespace = mdocDefaultNamespace(docType);
        const issuer = new Issuer(docType, mdocContext);
        const fields = [
            {
                path: ["family_name"],
                type: "string",
                defaultValue: "MUSTERMANN",
            },
            { path: ["given_name"], type: "string" },
            {
                path: ["address"],
                type: "object",
                children: [
                    {
                        path: ["street"],
                        type: "string",
                        defaultValue: "HEIDESTRASSE",
                    },
                    {
                        path: ["since"],
                        type: "string",
                        format: "date",
                        defaultValue: "2000-01-01",
                    },
                ],
            },
        ];

        service.addClaimsToIssuer(issuer, fields, mdlNamespace, {
            given_name: "ERIKA",
        });

        // Top-level and child defaults go into the default namespace, not
        // into one named after the parent.
        expect(addNamespaceSpy).toHaveBeenCalledTimes(1);
        expect(addNamespaceSpy).toHaveBeenCalledWith(mdlNamespace, {
            family_name: "MUSTERMANN",
            given_name: "ERIKA",
            address: {
                street: "HEIDESTRASSE",
                since: new DateOnly("2000-01-01"),
            },
        });
        expect(
            buildClaimsMetadata(fields as any, mdlNamespace).map(
                (claim) => claim.path,
            ),
        ).toEqual([
            [mdlNamespace, "family_name"],
            [mdlNamespace, "given_name"],
            [mdlNamespace, "address"],
            [mdlNamespace, "address", "street"],
            [mdlNamespace, "address", "since"],
        ]);
    });

    test("keeps a session object of a parent without a namespace", () => {
        const addNamespaceSpy = vi.spyOn(
            Issuer.prototype as any,
            "addIssuerNamespace",
        );
        const service = createMdocIssuerService() as any;
        const mdlNamespace = mdocDefaultNamespace("org.iso.18013.5.1.mDL");
        const issuer = new Issuer("org.iso.18013.5.1.mDL", mdocContext);

        service.addClaimsToIssuer(
            issuer,
            [
                {
                    path: ["address"],
                    type: "object",
                    children: [
                        {
                            path: ["street"],
                            type: "string",
                            defaultValue: "HEIDESTRASSE",
                        },
                    ],
                },
            ],
            mdlNamespace,
            { address: { street: "MAIN" } },
        );

        // The session's top-level value replaces the default as a whole;
        // before, it was left out for a namespace named "address".
        expect(addNamespaceSpy).toHaveBeenCalledTimes(1);
        expect(addNamespaceSpy).toHaveBeenCalledWith(mdlNamespace, {
            address: { street: "MAIN" },
        });
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
