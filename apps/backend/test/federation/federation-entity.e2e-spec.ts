import "reflect-metadata";
import { join, resolve } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
    Openid4vpAuthorizationRequest,
    Openid4vpClient,
} from "@openid4vc/openid4vp";
import { setGlobalConfig } from "@openid4vc/utils";
import { digest, ES256 } from "@owf/crypto";
import { SdJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import {
    compactVerify,
    decodeJwt,
    decodeProtectedHeader,
    importJWK,
    type JWK,
    jwtVerify,
} from "jose";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "vitest";
import { KeyChainService } from "../../src/crypto/key/key-chain.service.js";
import { IssueCredential } from "../../src/issuer/configuration/credentials/application/issue-credential.js";
import { CredentialConfigCreate } from "../../src/issuer/configuration/credentials/dto/credential-config-create.dto.js";
import { IssuanceDto } from "../../src/issuer/configuration/issuance/dto/issuance.dto.js";
import { FederationTrustService } from "../../src/trust/federation-trust.service.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import {
    callbacks,
    createPresentationRequest,
    createTestFetch,
    encryptVpToken,
    readConfig,
    setupIssuanceTestApp,
} from "../utils.js";
import {
    type FederationKey,
    federationKey,
    serveEntityConfiguration,
    serveSubordinateStatement,
} from "./federation-fixture.js";

const TRUST_ANCHOR = "https://ta-entity.example.org";
const VCT = "urn:eudi:pid:de:federation";

type Jwks = { keys: JWK[] };
type EntityConfiguration = {
    iss: string;
    sub: string;
    exp: number;
    iat: number;
    jwks: Jwks;
    authority_hints?: string[];
    metadata: Record<string, Record<string, unknown> & { jwks?: Jwks }>;
};

/**
 * EUDIPLO as an OpenID Federation leaf entity below a trust anchor: it
 * publishes its entity configuration, issues SD-JWT VCs with a `kid` of its
 * credential issuer metadata, and its own verifier accepts them through the
 * trust chain, status list included. Its OID4VP requests can use the
 * `openid_federation` client identifier.
 */
describe("OpenID Federation entity", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let host: string;
    let entityId: string;
    let trustAnchorKey: FederationKey;
    let entityFederationKey: JWK;

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
        host = app.get(ConfigService).getOrThrow<string>("PUBLIC_URL");
        entityId = `${host}/issuers/root`;
        // The test entity id uses http://localhost.
        setGlobalConfig({ allowInsecureUrls: true });

        const keyChain = await request(app.getHttpServer())
            .post("/key-chain")
            .set("Authorization", `Bearer ${authToken}`)
            .send({ usageType: "federation", type: "standalone" })
            .expect(201);
        entityFederationKey = (
            await app
                .get(KeyChainService)
                .getPublicKeys("root", keyChain.body.id)
        )[0];
        trustAnchorKey = await federationKey("trust-anchor");
        // Trust anchors are only trusted with registered (pinned) keys.
        await request(app.getHttpServer())
            .post("/federation-trust-anchor")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "ta-entity",
                entityId: TRUST_ANCHOR,
                jwks: { keys: [trustAnchorKey.jwk] },
            })
            .expect(201);

        const configFolder = resolve(__dirname, "../fixtures");
        const issuanceConfig = readConfig<IssuanceDto>(
            join(configFolder, "haip/issuance/issuance.json"),
        );
        await request(app.getHttpServer())
            .post("/issuer/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...issuanceConfig,
                authorizationServers: issuanceConfig.authorizationServers?.map(
                    (server) => ({
                        ...server,
                        walletAttestationRequired: false,
                    }),
                ),
                dPopRequired: false,
                credentialResponseEncryption: false,
                credentialRequestEncryption: false,
                walletAttestationRequired: false,
                walletProviderTrustLists: [],
                federation: {
                    entityId,
                    trustAnchors: [
                        {
                            entityId: TRUST_ANCHOR,
                            entityConfigurationUri: `${TRUST_ANCHOR}/.well-known/openid-federation`,
                        },
                    ],
                    entityTypes: [
                        "openid_credential_issuer",
                        "openid_credential_verifier",
                    ],
                    entityMetadata: { organization_name: "EUDIPLO test" },
                    includeTrustChain: true,
                },
            } as IssuanceDto)
            .expect(201);

        const credential = readConfig<CredentialConfigCreate>(
            join(configFolder, "haip/issuance/credentials/pid-no-key.json"),
        );
        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                ...credential,
                id: "pid-fed",
                vct: VCT,
                sdJwtTrustFormat: "federation",
                statusManagement: true,
                keyBinding: true,
            })
            .expect(201);

        await request(app.getHttpServer())
            .post("/verifier/config")
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                id: "pid-fed-entity",
                description: "PID issued by the federation entity",
                dcql_query: {
                    credentials: [
                        {
                            id: "pid",
                            format: "dc+sd-jwt",
                            meta: { vct_values: [VCT] },
                            trusted_authorities: [
                                {
                                    type: "openid_federation",
                                    values: [TRUST_ANCHOR],
                                },
                            ],
                        },
                    ],
                },
            })
            .expect(201);
    });

    beforeEach(async () => {
        nock.disableNetConnect();
        nock.enableNetConnect(/127\.0\.0\.1|localhost/);
        app.get(FederationTrustService).clearTrustCache();
        // The trust anchor lists EUDIPLO's federation key.
        // Issuance and verification each resolve the chain.
        await serveEntityConfiguration({
            id: TRUST_ANCHOR,
            key: trustAnchorKey,
            persist: true,
        });
        await serveSubordinateStatement({
            issuer: TRUST_ANCHOR,
            issuerKey: trustAnchorKey,
            subject: entityId,
            subjectKey: { jwk: entityFederationKey as never },
            persist: true,
        });
    });

    afterEach(() => {
        nock.cleanAll();
        nock.enableNetConnect();
    });

    afterAll(async () => {
        setGlobalConfig({ allowInsecureUrls: false });
        await app?.close();
    });

    async function entityConfiguration(): Promise<EntityConfiguration> {
        const res = await request(app.getHttpServer())
            .get("/issuers/root/.well-known/openid-federation")
            .expect(200);
        expect(res.headers["content-type"]).toMatch(
            /^application\/entity-statement\+jwt/,
        );
        const { payload } = await compactVerify(
            res.text,
            await importJWK(entityFederationKey, "ES256"),
        );
        return JSON.parse(new TextDecoder().decode(payload));
    }

    const kids = (jwks: Jwks | undefined) =>
        (jwks?.keys ?? []).map((key) => key.kid);

    test("publishes a signed entity configuration with issuer and verifier metadata", async () => {
        const ec = await entityConfiguration();

        expect(ec.iss).toBe(entityId);
        expect(ec.sub).toBe(entityId);
        expect(ec.exp - ec.iat).toBe(86400);
        expect(ec.authority_hints).toEqual([TRUST_ANCHOR]);
        expect(kids(ec.jwks)).toEqual([entityFederationKey.kid]);
        expect(ec.metadata.federation_entity).toEqual({
            organization_name: "EUDIPLO test",
        });

        const issuer = ec.metadata.openid_credential_issuer;
        expect(issuer.credential_issuer).toBe(entityId);
        expect(issuer.credential_endpoint).toBe(`${entityId}/vci/credential`);
        expect(ec.metadata.oauth_authorization_server.issuer).toBe(entityId);
        const verifier = ec.metadata.openid_credential_verifier;
        expect(verifier.vp_formats_supported).toBeDefined();
        expect(verifier.jwks?.keys.some((key) => key.use === "enc")).toBe(true);

        // Credential issuer keys (attestation, status list) and verifier
        // keys (access, encryption) are separate sets, each kid listed once.
        const issuerKids = kids(issuer.jwks);
        expect(new Set(issuerKids).size).toBe(issuerKids.length);
        expect(issuerKids.length).toBeGreaterThanOrEqual(2);
        for (const kid of kids(verifier.jwks)) {
            expect(issuerKids).not.toContain(kid);
        }
        expect(issuer.jwks?.keys.every((key) => key.use === "sig")).toBe(true);

        // Federation keys and protocol keys are separate key sets.
        for (const protocolKeys of [issuer.jwks, verifier.jwks]) {
            expect(kids(protocolKeys)).not.toContain(entityFederationKey.kid);
            expect(protocolKeys?.keys.every((key) => key.d === undefined)).toBe(
                true,
            );
        }
    });

    async function issueFederationCredential() {
        const holder = await ES256.generateKeyPair();
        const credential = await app.get(IssueCredential).execute({
            credentialConfigurationId: "pid-fed",
            holderKey: holder.publicKey as never,
            session: { tenantId: "root", id: "federation-session" } as never,
        });
        return { credential, holder };
    }

    test("issues SD-JWT VCs with iss, kid and trust chain, without x5c", async () => {
        const { credential } = await issueFederationCredential();
        const jwt = credential.split("~")[0];
        const header = decodeProtectedHeader(jwt) as Record<string, unknown>;
        const payload = decodeJwt(jwt);

        expect(payload.iss).toBe(entityId);
        expect(header.x5c).toBeUndefined();
        const ec = await entityConfiguration();
        expect(kids(ec.metadata.openid_credential_issuer.jwks)).toContain(
            header.kid,
        );
        // Entity configuration, statement of the trust anchor, trust anchor.
        const trustChain = header.trust_chain as string[];
        expect(trustChain).toHaveLength(3);
        expect(decodeJwt(trustChain[0])).toMatchObject({
            iss: entityId,
            sub: entityId,
        });
        expect(decodeJwt(trustChain[1])).toMatchObject({
            iss: TRUST_ANCHOR,
            sub: entityId,
        });

        // The status list is signed with a key of the same metadata.
        const statusUri = (payload.status as { status_list: { uri: string } })
            .status_list.uri;
        const statusList = await request(app.getHttpServer())
            .get(new URL(statusUri).pathname)
            .expect(200);
        const statusHeader = decodeProtectedHeader(statusList.text);
        expect(kids(ec.metadata.openid_credential_issuer.jwks)).toContain(
            statusHeader.kid,
        );
    });

    /** A key-bound presentation of `credential` for the resolved request. */
    async function present(
        credential: string,
        holder: Awaited<ReturnType<typeof ES256.generateKeyPair>>,
        clientId: string,
        nonce: string,
    ) {
        const sdjwt = new SdJwtVcInstance({
            hasher: digest,
            kbSigner: await ES256.getSigner(holder.privateKey),
            kbSignAlg: "ES256",
        });
        return sdjwt.present(
            credential,
            {},
            {
                kb: {
                    payload: {
                        iat: Math.floor(Date.now() / 1000),
                        aud: clientId,
                        nonce,
                    },
                },
            },
        );
    }

    async function sessionOf(id: string) {
        const res = await request(app.getHttpServer())
            .get(`/session/${id}`)
            .set("Authorization", `Bearer ${authToken}`)
            .expect(200);
        return res.body;
    }

    test("its own verifier accepts the credential through the trust chain", async () => {
        const { credential, holder } = await issueFederationCredential();
        const client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
            },
        });

        const offer = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-fed-entity",
        }).expect(201);
        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: offer.body.uri,
        });
        const resolved = await client.resolveOpenid4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });
        const payload = resolved.authorizationRequestPayload;

        const vpToken = await present(
            credential,
            holder,
            payload.client_id as string,
            payload.nonce,
        );
        const response = await client.createOpenid4vpAuthorizationResponse({
            authorizationRequestPayload: authRequest.params,
            authorizationResponsePayload: {
                response: await encryptVpToken(vpToken, "pid", resolved),
            },
            ...callbacks,
        });
        await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload: response.authorizationResponsePayload,
            authorizationRequestPayload:
                payload as Openid4vpAuthorizationRequest,
        });

        const session = await sessionOf(offer.body.session);
        expect(session.errorReason ?? null).toBeNull();
        expect(session.status).toBe("completed");
    });

    test("signs openid_federation requests with a key of its verifier metadata", async () => {
        const ec = await entityConfiguration();
        const verifierMetadata = ec.metadata.openid_credential_verifier;
        const { credential, holder } = await issueFederationCredential();
        const client = new Openid4vpClient({
            callbacks: {
                ...callbacks,
                fetch: createTestFetch(app, () => host),
                // A wallet takes the key from the verifier metadata of the
                // trust chain, selected by kid.
                verifyJwt: async (signer, { compact }) => {
                    if (signer.method !== "federation") {
                        return callbacks.verifyJwt(signer, { compact });
                    }
                    const jwk = verifierMetadata.jwks?.keys.find(
                        (key) => key.kid === signer.kid,
                    );
                    if (!jwk) return { verified: false };
                    await jwtVerify(compact, await importJWK(jwk, signer.alg));
                    return { verified: true, signerJwk: jwk };
                },
            },
        });

        const offer = await createPresentationRequest(app, authToken, {
            response_type: ResponseType.URI,
            requestId: "pid-fed-entity",
            clientIdScheme: "openid_federation",
        }).expect(201);
        const authRequest = client.parseOpenid4vpAuthorizationRequest({
            authorizationRequest: offer.body.uri,
        });
        expect(authRequest.params.client_id).toBe(
            `openid_federation:${entityId}`,
        );

        const requestObject = await request(app.getHttpServer())
            .get(new URL(authRequest.params.request_uri as string).pathname)
            .expect(200);
        const header = decodeProtectedHeader(requestObject.text) as Record<
            string,
            unknown
        >;
        expect(header.x5c).toBeUndefined();
        expect(kids(verifierMetadata.jwks)).toContain(header.kid);
        expect(header.trust_chain).toHaveLength(3);
        expect(decodeJwt(requestObject.text).trust_chain).toBeUndefined();

        const resolved = await client.resolveOpenid4vpAuthorizationRequest({
            authorizationRequestPayload: authRequest.params,
            responseMode: { type: "direct_post" },
        });
        const payload = resolved.authorizationRequestPayload;
        const vpToken = await present(
            credential,
            holder,
            payload.client_id as string,
            payload.nonce,
        );
        const response = await client.createOpenid4vpAuthorizationResponse({
            authorizationRequestPayload: authRequest.params,
            authorizationResponsePayload: {
                response: await encryptVpToken(vpToken, "pid", resolved),
            },
            clientMetadata: verifierMetadata as never,
            ...callbacks,
        });
        await client.submitOpenid4vpAuthorizationResponse({
            authorizationResponsePayload: response.authorizationResponsePayload,
            authorizationRequestPayload:
                payload as Openid4vpAuthorizationRequest,
        });

        const session = await sessionOf(offer.body.session);
        expect(session.errorReason ?? null).toBeNull();
        expect(session.status).toBe("completed");
    });
});
