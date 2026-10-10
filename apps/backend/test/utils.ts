import crypto from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import {
    CallbackContext,
    Jwk,
    JwtHeader,
    SignJwtCallback,
} from "@openid4vc/oauth2";
import { ResolvedOpenid4vpAuthorizationRequest } from "@openid4vc/openid4vp";
import { digest, ES256 } from "@owf/crypto";
import {
    CoseKey,
    DeviceKey,
    DeviceRequest,
    DocRequest,
    Holder,
    Issuer,
    IssuerSigned,
    ItemsRequest,
    SessionTranscript,
    SignatureAlgorithm,
} from "@owf/mdoc";
import { X509Certificate } from "@peculiar/x509";
import { kbPayload } from "@sd-jwt/core";
import { SDJwtVcInstance } from "@sd-jwt/sd-jwt-vc";
import {
    calculateJwkThumbprint,
    EncryptJWT,
    exportJWK,
    importJWK,
    importX509,
    JWK,
    jwtVerify,
    SignJWT,
} from "jose";
import request from "supertest";
import { App } from "supertest/types";
import { AppModule } from "../src/app.module.js";
import { Role } from "../src/auth/roles/role.enum.js";
import { KeyChainImportDto } from "../src/crypto/key/dto/key-chain-import.dto.js";
import { KeyChainService } from "../src/crypto/key/key-chain.service.js";
import { CredentialConfigCreate } from "../src/issuer/configuration/credentials/dto/credential-config-create.dto.js";
import { IssuanceDto } from "../src/issuer/configuration/issuance/dto/issuance.dto.js";
import { CreateWebhookEndpointDto } from "../src/issuer/configuration/webhook-endpoint/dto/create-webhook-endpoint.dto.js";
import { StatusListService } from "../src/issuer/status-list/status-list.service.js";
import { TrustListCreateDto } from "../src/issuer/trust-list/dto/trust-list-create.dto.js";
import { createAppValidationPipe } from "../src/shared/common/zod/zod-schema.util.js";
import { PresentationRequest } from "../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { PresentationConfigCreateDto } from "../src/verifier/presentations/dto/presentation-config-create.dto.js";
import { DEVICE_JWK, mdocContext } from "./utils-mdoc.js";

export function readConfig<T>(path: string): T {
    const input = JSON.parse(readFileSync(path, "utf-8"));
    if (!input.spec || typeof input.spec !== "object") {
        return input as T;
    }

    const spec = structuredClone(input.spec);
    if (spec.keySource?.type === "private-jwk") {
        spec.key = spec.keySource.jwk;
        delete spec.keySource;
    }
    return spec as T;
}

export async function prepareMdocPresentation(
    nonce: string,
    privateKey: CryptoKey,
    issuerCert: string,
    clientId: string,
    responseUri: string,
    responseMode: string = "direct_post.jwt",
    jwkThumbprint?: Uint8Array,
    mdocStatus?: {
        statusList: {
            idx: number;
            uri: string;
        };
    },
) {
    // Use the EU PID docType and namespace to match the pid-de fixture
    const docType = "eu.europa.ec.eudi.pid.1";
    const namespace = "eu.europa.ec.eudi.pid.1";

    const issuer = new Issuer(docType, mdocContext);

    const signed = new Date();
    const validFrom = new Date(signed);
    const validUntil = new Date(signed);
    validUntil.setFullYear(signed.getFullYear() + 30);

    // Add claims with the correct names expected by the DCQL query
    issuer.addIssuerNamespace(namespace, {
        given_name: "First",
        family_name: "Last",
        first_name: "First", // Keep for backward compatibility
        last_name: "Last", // Keep for backward compatibility
    });

    //TODO: get key from eudiplo so it matches with the trust list
    const key = await exportJWK(privateKey);

    const issuerSigned = await issuer.sign({
        signingKey: CoseKey.fromJwk(key as Jwk),
        certificates: [new Uint8Array(new X509Certificate(issuerCert).rawData)],
        algorithm: SignatureAlgorithm.ES256,
        digestAlgorithm: "SHA-256",
        deviceKeyInfo: { deviceKey: DeviceKey.fromJwk(DEVICE_JWK) },
        validityInfo: { signed, validFrom, validUntil },
        status: mdocStatus,
    });

    const encodedIssuerSigned = issuerSigned.encodedForOid4Vci;

    // openid4vci protocol

    const credential = IssuerSigned.fromEncodedForOid4Vci(encodedIssuerSigned);

    const deviceRequest = DeviceRequest.create({
        docRequests: [
            DocRequest.create({
                itemsRequest: ItemsRequest.create({
                    docType: docType,
                    namespaces: {
                        [namespace]: {
                            given_name: true,
                            family_name: true,
                            first_name: true,
                            last_name: true,
                        },
                    },
                }),
            }),
        ],
    });

    const sessionTranscript = await SessionTranscript.forOid4Vp(
        {
            protocol: "openid4vp",
            clientId,
            responseUri,
            nonce,
            responseMode,
            ...(jwkThumbprint ? { jwkThumbprint } : {}),
        },
        mdocContext,
    );

    const deviceResponse = await Holder.createDeviceResponseForDeviceRequest(
        {
            deviceRequest,
            sessionTranscript,
            documents: [
                {
                    docRequestIndex: 0,
                    issuerSigned: credential,
                    signature: {
                        signingKey: CoseKey.fromJwk({
                            ...DEVICE_JWK,
                            alg: "ES256",
                        }),
                    },
                },
            ],
        },
        mdocContext,
    );

    return deviceResponse.encodedForOid4Vp;
}

async function createCredential(options: {
    claims: any;
    privateKey: CryptoKey;
    x5c: string[];
}) {
    //create keypair for holder
    const { privateKeyHolder, publicKeyHolder } =
        await ES256.generateKeyPair().then((keyPair) => ({
            privateKeyHolder: keyPair.privateKey,
            publicKeyHolder: keyPair.publicKey,
        }));

    const sdjwt = new SDJwtVcInstance({
        signer: async (data: string) => {
            const encoder = new TextEncoder();
            const signature = await globalThis.crypto.subtle.sign(
                { name: "ECDSA", hash: "SHA-256" },
                options.privateKey,
                encoder.encode(data),
            );

            return btoa(String.fromCodePoint(...new Uint8Array(signature)))
                .replaceAll("+", "-")
                .replaceAll("/", "_")
                .replace(/=+$/, ""); // Convert to base64url format
        },
        signAlg: "ES256",
        hasher: digest,
        loadTypeMetadataFormat: true,
        saltGenerator: (length: number) =>
            crypto.randomBytes(length).toString("base64url"),
    });

    return sdjwt
        .issue(
            {
                ...options.claims,
                cnf: { jwk: publicKeyHolder },
            },
            undefined,
            {
                header: {
                    x5c: options.x5c,
                },
            },
        )
        .then((credential) => ({
            credential,
            privateKey: privateKeyHolder,
        }));
}

export async function preparePresentation(
    kb: Omit<kbPayload, "sd_hash">,
    privateKey: CryptoKey,
    x5c: string[],
    statusListService: StatusListService,
    credentialConfigId: string,
    sessionId = "1",
) {
    // createEntry returns `{ status: { status_list } }`, so it is spread into
    // the claims to put `status_list` at `status.status_list`.
    const status = await statusListService.createEntry(
        { tenantId: "root", id: sessionId } as any,
        credentialConfigId,
    );

    const credential = await createCredential({
        claims: {
            vct: "http://localhost:3000/issuers/demo/credentials-metadata/vct/pid",
            ...status,
            // Include claims that can be selectively disclosed
            birthdate: "1990-01-01",
            address: {
                locality: "Berlin",
                country: "DE",
            },
        },
        privateKey,
        x5c,
    });

    const sdjwt = new SDJwtVcInstance({
        hasher: digest,
        kbSigner: await ES256.getSigner(credential.privateKey),
        kbSignAlg: "ES256",
    });
    const presentation = await sdjwt.present(
        credential.credential,
        {
            birthdate: true,
            address: {
                locality: true,
            },
        },
        {
            kb: {
                payload: kb,
            },
        },
    );
    return presentation;
}

export const callbacks: any = {
    hash: (data, alg) =>
        crypto
            .createHash(alg.replace("-", "").toLowerCase())
            .update(data)
            .digest(),
    generateRandom: (bytes) => crypto.randomBytes(bytes),
    /* clientAuthentication: clientAuthenticationNone({
        clientId: 'some-random-client-id',
    }), */
    verifyJwt: async (signer, { compact, payload }) => {
        let jwk: Jwk;
        let publicKey: CryptoKey;
        if (signer.method === "jwk") {
            jwk = signer.publicJwk;
            publicKey = (await importJWK(jwk as JWK, signer.alg)) as CryptoKey;
        } else if (signer.method === "x5c") {
            const headerB64 = compact.split(".")[0];
            const header: JwtHeader = JSON.parse(
                Buffer.from(headerB64, "base64url").toString(),
            );
            if (!header.x5c || header.x5c.length === 0) {
                throw new Error("x5c header parameter is missing or empty");
            }
            const certPem = `-----BEGIN CERTIFICATE-----\n${header.x5c[0]}\n-----END CERTIFICATE-----`;
            publicKey = await importX509(certPem, signer.alg);
            jwk = (await exportJWK(publicKey)) as Jwk;
        } else {
            throw new Error("Signer method not supported");
        }

        try {
            await jwtVerify(compact, publicKey, {
                currentDate: payload.exp
                    ? new Date((payload.exp - 300) * 1000)
                    : undefined,
            });
            return {
                verified: true,
                signerJwk: jwk,
            };
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (_error) {
            return {
                verified: false,
            };
        }
    },
    getX509CertificateMetadata: (
        certificate: string,
    ): {
        sanDnsNames: string[];
        sanUriNames: string[];
    } => {
        const cert1 = new crypto.X509Certificate(
            `-----BEGIN CERTIFICATE-----\n${certificate}\n-----END CERTIFICATE-----`,
        );
        const sanDnsNames = cert1
            .subjectAltName!.split(",")
            .map((name) => name.replace("DNS:", "").trim());
        const sanUriNames = [];

        return {
            sanDnsNames,
            sanUriNames,
        };
    },
} as const satisfies Partial<CallbackContext>;

export const getSignJwtCallback = (privateJwks: Jwk[]): SignJwtCallback => {
    return async (signer, { header, payload }) => {
        let jwk: Jwk;
        if (signer.method === "jwk") {
            jwk = signer.publicJwk;
        } else {
            throw new Error("Signer method not supported");
        }

        const jwkThumprint = await calculateJwkThumbprint(jwk as JWK, "sha256");

        // add cnf
        payload.cnf = {
            jkt: jwkThumprint,
        };

        const privateJwk = await Promise.all(
            privateJwks.map(async (jwk) =>
                (await calculateJwkThumbprint(jwk as JWK, "sha256")) ===
                jwkThumprint
                    ? jwk
                    : undefined,
            ),
        ).then((jwks) => jwks.find((jwk) => jwk !== undefined));

        if (!privateJwk) {
            throw new Error(
                `No private key available for public jwk \n${JSON.stringify(jwk, null, 2)}`,
            );
        }

        const josePrivateKey = await importJWK(privateJwk as JWK, signer.alg);
        const jwt = await new SignJWT(payload)
            .setProtectedHeader(header)
            .sign(josePrivateKey);

        return {
            jwt: jwt,
            signerJwk: jwk,
        };
    };
};

/**
 * Creates a client with `roles` in the tenant of `authToken` and returns an
 * access token of that client.
 */
export async function clientToken(
    app: INestApplication,
    authToken: string,
    clientId: string,
    roles: Role[],
): Promise<string> {
    const client = await request(app.getHttpServer())
        .post("/client")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send({ clientId, roles })
        .expect(201);
    const response = await request(app.getHttpServer())
        .post("/api/oauth2/token")
        .trustLocalhost()
        .send({
            client_id: clientId,
            client_secret: client.body.clientSecret,
            grant_type: "client_credentials",
        })
        .expect(201);
    return response.body.access_token as string;
}

/**
 * Creates a tenant and returns the access token for a client.
 * @param app
 * @param clientId
 * @param clientSecret
 * @param tenantId - Optional tenant ID, defaults to "root"
 * @returns
 */
export async function getToken(
    app: INestApplication,
    clientId: string,
    clientSecret: string,
    tenantId = "root",
) {
    // Get JWT token using client credentials
    const tokenResponse = await request(app.getHttpServer())
        .post("/api/oauth2/token")
        .trustLocalhost()
        .send({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "client_credentials",
        })
        .expect(201);
    const authToken = tokenResponse.body.access_token;
    expect(authToken).toBeDefined();

    // create tenant
    const client = await request(app.getHttpServer())
        .post("/tenant")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send({
            id: tenantId,
            name: `${tenantId.charAt(0).toUpperCase() + tenantId.slice(1)} Tenant`,
            roles: [
                Role.Clients,
                Role.IssuanceOffer,
                Role.Issuances,
                Role.PresentationRequest,
                Role.Presentations,
            ],
        })
        .then((res) => res.body.client);

    return request(app.getHttpServer())
        .post("/api/oauth2/token")
        .trustLocalhost()
        .send({
            client_id: client.clientId,
            client_secret: client.clientSecret,
            grant_type: "client_credentials",
        })
        .then((res) => res.body.access_token);
}

/**
 * Create a tenant whose client holds `tenant:admin` besides `roles`, and
 * return that client's access token. Uses the root client credentials.
 */
export async function getTenantAdminToken(
    app: INestApplication,
    clientId: string,
    clientSecret: string,
    tenantId: string,
    roles: Role[] = [Role.Issuances],
): Promise<string> {
    const bootstrap = await request(app.getHttpServer())
        .post("/api/oauth2/token")
        .send({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
        })
        .expect(201);
    const tenant = await request(app.getHttpServer())
        .post("/tenant")
        .set("Authorization", `Bearer ${bootstrap.body.access_token}`)
        .send({
            id: tenantId,
            name: `${tenantId} tenant`,
            roles: [...roles, Role.TenantAdmin],
        })
        .expect(201);
    return request(app.getHttpServer())
        .post("/api/oauth2/token")
        .send({
            grant_type: "client_credentials",
            client_id: tenant.body.client.clientId,
            client_secret: tenant.body.client.clientSecret,
        })
        .expect(201)
        .then((res) => res.body.access_token);
}

export function getDefaultSecret(input: string): string {
    const pattern = /\$\{([A-Z0-9_]+)(?::([^}]*))?\}/g;
    return input.replaceAll(
        pattern,
        (fullMatch, varName: string, defVal: string) => {
            return defVal;
        },
    );
}

/**
 * Shared test context returned by setupIssuanceTestApp
 */
export interface IssuanceTestContext {
    app: INestApplication<App>;
    authToken: string;
    clientId: string;
    clientSecret: string;
}

/**
 * Sets up a complete test application with all issuance configurations.
 * This is a shared setup for all issuance-related e2e tests.
 */
export async function setupIssuanceTestApp(): Promise<IssuanceTestContext> {
    // Delete the database
    rmSync("../../tmp/service.db", { force: true });

    const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
    }).compile();

    const app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());

    const configService = app.get(ConfigService);
    configService.set("CONFIG_IMPORT_MODE", "disabled");
    configService.set("LOG_LEVEL", "debug");
    const clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
    const clientSecret = configService.getOrThrow<string>("AUTH_CLIENT_SECRET");

    await app.init();
    await app.listen(3000);

    const authToken = await getToken(app, clientId, clientSecret);

    const configFolder = resolve(__dirname + "/fixtures");

    // Create attestation key chain for credential signing
    await request(app.getHttpServer())
        .post("/key-chain/import")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
            ...readConfig<KeyChainImportDto>(
                join(configFolder, "haip/key-chains/attestation.json"),
            ),
        })
        .expect(201);

    // Create access key chain for access tokens
    await request(app.getHttpServer())
        .post("/key-chain/import")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
            ...readConfig<KeyChainImportDto>(
                join(configFolder, "haip/key-chains/access.json"),
            ),
        })
        .expect(201);

    // Create status list key chain
    await request(app.getHttpServer())
        .post("/key-chain/import")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
            ...readConfig<KeyChainImportDto>(
                join(configFolder, "haip/key-chains/status-list.json"),
            ),
        })
        .expect(201);

    // Create trust list key chain
    await request(app.getHttpServer())
        .post("/key-chain/import")
        .set("Authorization", `Bearer ${authToken}`)
        .send({
            ...readConfig<KeyChainImportDto>(
                join(configFolder, "haip/key-chains/trust-list.json"),
            ),
        })
        .expect(201);

    // Import image
    await request(app.getHttpServer())
        .post("/storage")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .attach("file", join(configFolder, "haip/images/company.png"))
        .expect(201);

    // Import issuance config (disable wallet attestation for non-OIDF tests)
    const issuanceConfig = readConfig<IssuanceDto>(
        join(configFolder, "haip/issuance/issuance.json"),
    );
    await request(app.getHttpServer())
        .post("/issuer/config")
        .trustLocalhost()
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
        } as IssuanceDto)
        .expect(201);

    // Import the pid credential configuration

    await request(app.getHttpServer())
        .post("/issuer/credentials")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send(
            readConfig<CredentialConfigCreate>(
                join(configFolder, "haip/issuance/credentials/pid-no-key.json"),
            ),
        )
        .expect(201);

    // Import citizen presentation config
    await request(app.getHttpServer())
        .post("/verifier/config")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send(
            readConfig<PresentationConfigCreateDto>(
                join(configFolder, "haip/presentation/pid.json"),
            ),
        )
        .expect(201);

    // Import the citizen attribute provider
    await request(app.getHttpServer())
        .post("/issuer/attribute-providers")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send(
            readConfig(
                join(configFolder, "haip/attribute-providers/citizen-ap.json"),
            ),
        )
        .expect(201);

    // Import the citizen credential configuration
    await request(app.getHttpServer())
        .post("/issuer/credentials")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send(
            readConfig<CredentialConfigCreate>(
                join(configFolder, "haip/issuance/credentials/citizen.json"),
            ),
        )
        .expect(201);

    // Import mDOC credential configuration
    await request(app.getHttpServer())
        .post("/issuer/credentials")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send(
            readConfig<CredentialConfigCreate>(
                join(configFolder, "haip/issuance/credentials/pid-mdoc.json"),
            ),
        )
        .expect(201);

    await request(app.getHttpServer())
        .post("/issuer/credentials")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send(
            readConfig<CredentialConfigCreate>(
                join(
                    configFolder,
                    "haip/issuance/credentials/pid-mdoc-no-key.json",
                ),
            ),
        )
        .expect(201);

    return { app, authToken, clientId, clientSecret };
}

/**
 * `trusted_authorities` of a DCQL credential query that accepts the test
 * issuer (attestation key chain), listed in the fixture trust list
 * `haip/trust-lists/pid-tl.json`.
 */
export const FIXTURE_TRUSTED_AUTHORITIES = [
    {
        type: "etsi_tl" as const,
        values: [{ trustListId: "580831bc-ef11-43f4-a3be-a2b6bf1b29a3" }],
    },
];

/**
 * Shared test context returned by setupPresentationTestApp
 */
export interface PresentationTestContext {
    app: INestApplication<App>;
    authToken: string;
    host: string;
    clientId: string;
    clientSecret: string;
    privateIssuerKey: CryptoKey;
    issuerCert: string;
    /** Full certificate chain as base64 DER values (ready for x5c header) */
    issuerCertChain: string[];
    statusListService: StatusListService;
}

/**
 * Sets up a complete test application for presentation e2e tests.
 * This includes keys, certificates, presentation configs, and trust lists.
 */
export async function setupPresentationTestApp(): Promise<PresentationTestContext> {
    // Delete the database
    rmSync("../../tmp/service.db", { force: true });

    const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
    }).compile();

    const app = moduleFixture.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());

    const configService = app.get(ConfigService);
    const configFolder = resolve(__dirname + "/fixtures");
    configService.set("CONFIG_FOLDER", configFolder);
    const host = configService.getOrThrow("PUBLIC_URL");
    const clientId = configService.getOrThrow<string>("AUTH_CLIENT_ID");
    const clientSecret = configService.getOrThrow<string>("AUTH_CLIENT_SECRET");

    const statusListService = app.get(StatusListService);

    await app.init();
    await app.listen(3000);

    const authToken = await getToken(app, clientId, clientSecret);

    // Helper to make requests and show detailed error on failure
    async function expectRequest(
        req: request.Test,
        expectedStatus: number,
    ): Promise<request.Response> {
        const res = await req;
        if (res.status !== expectedStatus) {
            console.error(
                `Request failed: expected ${expectedStatus}, got ${res.status} for endpoint ${req.url}`,
            );
            console.error("Response body:", JSON.stringify(res.body, null, 2));
        }
        expect(res.status).toBe(expectedStatus);
        return res;
    }

    // Import access key chain (for OAuth/authentication)
    const accessKeyChain = readConfig<KeyChainImportDto>(
        join(configFolder, "haip/key-chains/access.json"),
    );

    await expectRequest(
        request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(accessKeyChain),
        201,
    );

    // Import presentation configuration without webhook
    await expectRequest(
        request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<PresentationConfigCreateDto>(
                    join(configFolder, "haip/presentation/pid-no-hook.json"),
                ),
            ),
        201,
    );

    // Import status list key chain
    const statusListKeyChain = readConfig<KeyChainImportDto>(
        join(configFolder, "haip/key-chains/status-list.json"),
    );

    await expectRequest(
        request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(statusListKeyChain),
        201,
    );

    // Import trust list key chain
    const trustListKeyChain = readConfig<KeyChainImportDto>(
        join(configFolder, "haip/key-chains/trust-list.json"),
    );

    await expectRequest(
        request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(trustListKeyChain),
        201,
    );

    // Import attestation key chain (referenced by trust list entities for credential signing)
    const attestationKeyChain = readConfig<KeyChainImportDto>(
        join(configFolder, "haip/key-chains/attestation.json"),
    );

    await expectRequest(
        request(app.getHttpServer())
            .post("/key-chain/import")
            .set("Authorization", `Bearer ${authToken}`)
            .send(attestationKeyChain),
        201,
    );

    // Retrieve the active (leaf) key and certificate from the imported attestation key chain.
    // With rotation enabled, the fixture key becomes the root CA and a new leaf key is generated.
    const keyChainService = app.get(KeyChainService);
    const attestationEntity = await keyChainService.getEntity(
        "root",
        attestationKeyChain.id!,
    );
    const privateIssuerKey = (await importJWK(
        attestationEntity.activeJwk,
        "ES256",
        { extractable: true },
    )) as CryptoKey;

    // Split the certificate chain into individual PEMs
    const certPems = attestationEntity.activeCertificate.match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ) ?? [attestationEntity.activeCertificate];
    const issuerCert = certPems[0]; // leaf PEM (for mdoc)
    const issuerCertChain = certPems.map((pem) =>
        pem
            .replace("-----BEGIN CERTIFICATE-----", "")
            .replace("-----END CERTIFICATE-----", "")
            .replaceAll(/\r?\n|\r/g, ""),
    );

    // Import trust list
    await expectRequest(
        request(app.getHttpServer())
            .post("/trust-list")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<TrustListCreateDto>(
                    join(configFolder, "haip/trust-lists/pid-tl.json"),
                ),
            ),
        201,
    );

    // import webhook endpoint for testing webhook calls
    await expectRequest(
        request(app.getHttpServer())
            .post("/issuer/webhook-endpoints")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<CreateWebhookEndpointDto>(
                    join(
                        configFolder,
                        "haip/webhook-endpoints/notification.json",
                    ),
                ),
            ),
        201,
    );

    // Import presentation configs for pid-de and pid
    await expectRequest(
        request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<PresentationConfigCreateDto>(
                    join(configFolder, "haip/presentation/pid-de.json"),
                ),
            ),
        201,
    );

    await expectRequest(
        request(app.getHttpServer())
            .post("/verifier/config")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(
                readConfig<PresentationConfigCreateDto>(
                    join(configFolder, "haip/presentation/pid.json"),
                ),
            ),
        201,
    );

    return {
        app,
        authToken,
        host,
        clientId,
        clientSecret,
        privateIssuerKey,
        issuerCert,
        issuerCertChain,
        statusListService,
    };
}

/**
 * Helper function to encrypt and prepare VP token
 */
export async function encryptVpToken(
    vp_token: string,
    credentialId: string,
    resolved: ResolvedOpenid4vpAuthorizationRequest,
    enc: "A128GCM" | "A256GCM" = "A128GCM",
): Promise<string> {
    const key = (await importJWK(
        resolved.authorizationRequestPayload.client_metadata?.jwks
            ?.keys[0] as JWK,
        "ECDH-ES",
    )) as CryptoKey;

    return new EncryptJWT({
        vp_token: { [credentialId]: [vp_token] },
        state: resolved.authorizationRequestPayload.state!,
    })
        .setProtectedHeader({
            alg: "ECDH-ES",
            enc,
        })
        .setIssuedAt()
        .setExpirationTime("2h")
        .encrypt(key);
}

/**
 * Creates a test fetch function for Openid4vpClient that routes requests through supertest
 */
export function createTestFetch(
    app: INestApplication<App>,
    getHost: () => string,
) {
    return async (uri: string, init: RequestInit) => {
        const path = uri.split(getHost())[1];
        let response: request.Response;
        if (init.method === "POST") {
            response = await request(app.getHttpServer())
                .post(path)
                .trustLocalhost()
                .send(init.body!);
        } else {
            response = await request(app.getHttpServer())
                .get(path)
                .trustLocalhost();
        }
        return {
            ok: true,
            text: () => response.text,
            json: () => response.body,
            status: response.status,
            headers: response.headers,
        };
    };
}

/**
 * Helper function to create a presentation request via the verifier API
 */
export function createPresentationRequest(
    app: INestApplication<App>,
    authToken: string,
    requestBody: PresentationRequest,
) {
    return request(app.getHttpServer())
        .post("/verifier/offer")
        .trustLocalhost()
        .set("Authorization", `Bearer ${authToken}`)
        .send(requestBody);
}
