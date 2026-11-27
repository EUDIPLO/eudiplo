import { generateKeyPairSync, webcrypto } from "node:crypto";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import * as x509 from "@peculiar/x509";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigDocumentValidationService } from "./config-document-validation.service.js";
import { ConfigMigrationService } from "./config-migration.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";

describe("ConfigDocumentValidationService", () => {
    const privateJwk = generateKeyPairSync("ec", {
        namedCurve: "P-256",
    }).privateKey.export({ format: "jwk" });
    const migrations = new ConfigMigrationService(new ConfigResourceRegistry());
    const skipOveraskingCheck = { value: false };
    const service = new ConfigDocumentValidationService(migrations, {
        get: (key: string) =>
            ({
                SKIP_OVERASKING_CHECK: skipOveraskingCheck.value,
            })[key],
        getOrThrow: (key: string) => {
            if (key !== "PUBLIC_URL") throw new Error(key);
            return "https://eudiplo.example";
        },
    } as any);

    it("accepts an explicit key-regeneration decision", () => {
        expect(
            service.validate(
                {
                    $schema: schemaUrl("KeyChain"),
                    kind: "KeyChain",
                    metadata: {},
                    spec: {
                        id: "issuer",
                        usageType: "attestation",
                        kmsProvider: "db",
                        keySource: {
                            type: "regenerate",
                            keyChainType: "internalChain",
                        },
                    },
                },
                undefined,
            ),
        ).toEqual([]);
    });

    it("accepts the null rotation values of earlier exports with a private key", () => {
        expect(
            service.validate(
                {
                    $schema: schemaUrl("KeyChain"),
                    kind: "KeyChain",
                    metadata: {},
                    spec: {
                        id: "issuer",
                        usageType: "attestation",
                        keySource: { type: "private-jwk", jwk: privateJwk },
                        rotationPolicy: {
                            enabled: false,
                            intervalDays: null,
                            certValidityDays: null,
                        },
                    },
                },
                undefined,
            ),
        ).toEqual([]);
    });

    describe("key chains with private keys", () => {
        const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" };
        const keyChain = (keySource: Record<string, unknown>) => ({
            $schema: schemaUrl("KeyChain"),
            kind: "KeyChain" as const,
            metadata: {},
            spec: {
                id: "issuer",
                usageType: "attestation",
                keySource: { type: "private-jwk", ...keySource },
                crt: ["root certificate"],
                activeCertificate: "active certificate",
            },
        });

        it("checks the keys and certificates of an internal chain instead of the importer schema", () => {
            expect(
                service
                    .validate(keyChain({ jwk, activeJwk: jwk }), undefined)
                    .map(({ code, path, resource }) => ({
                        code,
                        path,
                        resource,
                    })),
            ).toEqual([
                {
                    code: "INVALID_PRIVATE_KEY",
                    path: "/spec/keySource/jwk",
                    resource: { kind: "KeyChain", id: "issuer" },
                },
                {
                    code: "INVALID_PRIVATE_KEY",
                    path: "/spec/keySource/activeJwk",
                    resource: { kind: "KeyChain", id: "issuer" },
                },
                {
                    code: "INVALID_CERTIFICATE",
                    path: "/spec/crt/0",
                    resource: { kind: "KeyChain", id: "issuer" },
                },
                {
                    code: "INVALID_CERTIFICATE",
                    path: "/spec/activeCertificate",
                    resource: { kind: "KeyChain", id: "issuer" },
                },
            ]);
        });

        it("checks the text of an escaped form as a key and leaves a placeholder to SECRET_REQUIRED", () => {
            const codes = (whole: ReadonlySet<string>) =>
                service
                    .validate(keyChain({ jwk: "${A}" }), whole)
                    .map(({ code }) => code);

            // Read from "$${A}": no placeholder at that path.
            expect(codes(new Set())).toContain("INVALID_PRIVATE_KEY");
            expect(codes(new Set(["/keySource/jwk"]))).not.toContain(
                "INVALID_PRIVATE_KEY",
            );
        });

        it("keeps the importer schema for a private key without activeJwk", () => {
            expect(
                service.validate(keyChain({ jwk: privateJwk }), undefined),
            ).toEqual([
                expect.objectContaining({
                    code: "CURRENT_SCHEMA_VALIDATION_FAILED",
                    path: "/spec/",
                    message: expect.stringContaining("activeCertificate"),
                }),
            ]);
        });

        it.each([
            ["without d", { ...privateJwk, d: undefined }],
            [
                "whose d belongs to another key",
                {
                    ...privateJwk,
                    d: generateKeyPairSync("ec", {
                        namedCurve: "P-256",
                    }).privateKey.export({ format: "jwk" }).d,
                },
            ],
        ])("rejects a private key %s without activeJwk", (_, key) => {
            expect(
                service
                    .validate(keyChain({ jwk: key }), undefined)
                    .filter(({ code }) => code === "INVALID_PRIVATE_KEY"),
            ).toEqual([
                expect.objectContaining({
                    path: "/spec/keySource/jwk",
                    resource: { kind: "KeyChain", id: "issuer" },
                }),
            ]);
        });

        it.each([
            ["a redacted private key", "${KEYCHAIN_ISSUER_KEYSOURCE_JWK}"],
            [
                "a private key with a placeholder d",
                { ...privateJwk, d: "${ISSUER_D}" },
            ],
        ])("reports no INVALID_PRIVATE_KEY for %s", (_, jwk) => {
            expect(
                service
                    .validate(keyChain({ jwk }), undefined)
                    .filter(({ code }) => code === "INVALID_PRIVATE_KEY"),
            ).toEqual([]);
        });
    });

    it.each([
        [
            "standalone",
            {
                type: "private-jwk",
                jwk: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" },
                activeJwk: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" },
            },
        ],
        [
            "internalChain",
            {
                type: "external-reference",
                provider: "vault",
                externalKeyId: "key",
                publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
            },
        ],
        ["standalone", { type: "regenerate", keyChainType: "internalChain" }],
    ])(
        "reports a type %s that contradicts the key source",
        (type, keySource) => {
            const issues = service.validate(
                {
                    $schema: schemaUrl("KeyChain"),
                    kind: "KeyChain",
                    metadata: {},
                    spec: {
                        id: "issuer",
                        usageType: "attestation",
                        type,
                        keySource,
                    },
                },
                undefined,
            );

            expect(issues).toContainEqual(
                expect.objectContaining({
                    code: "KEY_CHAIN_TYPE_MISMATCH",
                    path: "/spec/type",
                }),
            );
        },
    );

    it.each([
        { type: "regenerate", keyChainType: "internalChain" },
        // Without keyChainType, type decides the regenerated key chain.
        { type: "regenerate" },
    ])("accepts a type that matches the key source %o", (keySource) => {
        expect(
            service.validate(
                {
                    $schema: schemaUrl("KeyChain"),
                    kind: "KeyChain",
                    metadata: {},
                    spec: {
                        id: "issuer",
                        usageType: "attestation",
                        type: "internalChain",
                        keySource,
                    },
                },
                undefined,
            ),
        ).toEqual([]);
    });

    it("accepts identity carried by the schema-described spec", () => {
        expect(
            service.validate(
                {
                    $schema: schemaUrl("Client"),
                    kind: "Client",
                    metadata: {},
                    spec: {
                        clientId: "different",
                        roles: ["clients:manage"],
                    },
                },
                undefined,
            ),
        ).toEqual([]);
    });

    describe("presentation configs", () => {
        const presentation = (trusted_authorities?: unknown[]) => ({
            $schema: schemaUrl("PresentationConfig"),
            kind: "PresentationConfig" as const,
            metadata: {},
            spec: {
                id: "pid",
                dcql_query: {
                    credentials: [
                        {
                            id: "pid",
                            format: "dc+sd-jwt",
                            meta: { vct_values: ["urn:eudi:pid:1"] },
                            ...(trusted_authorities
                                ? { trusted_authorities }
                                : {}),
                        },
                    ],
                },
            },
        });

        it("accepts credential queries with trusted_authorities", () => {
            expect(
                service.validate(
                    presentation([
                        {
                            type: "etsi_tl",
                            values: [{ trustListId: "pid-issuers" }],
                        },
                    ]),
                    undefined,
                ),
            ).toEqual([]);
        });

        it("reports credential queries without trusted_authorities", () => {
            expect(service.validate(presentation(), undefined)).toEqual([
                expect.objectContaining({
                    severity: "error",
                    code: "TRUSTED_AUTHORITY_REQUIRED",
                    path: "/spec/dcql_query/credentials",
                    message: expect.stringContaining(
                        "Credential queries without trusted_authorities: pid.",
                    ),
                    resource: { kind: "PresentationConfig", id: "pid" },
                }),
            ]);
        });

        it("accepts them when the spec sets allowUntrustedIssuers", () => {
            const document = presentation();
            expect(
                service.validate(
                    {
                        ...document,
                        spec: { ...document.spec, allowUntrustedIssuers: true },
                    },
                    undefined,
                ),
            ).toEqual([]);
        });

        describe("transaction data", () => {
            const withTransactionData = (transaction_data: unknown) => {
                const document = presentation([
                    {
                        type: "etsi_tl",
                        values: [{ trustListId: "pid-issuers" }],
                    },
                ]);
                return {
                    ...document,
                    spec: { ...document.spec, transaction_data },
                };
            };
            const entry = (credential_ids: string[]) => ({
                type: "urn:eudi:sca:account_access:1",
                credential_ids,
                payload: { transaction_id: "t-1" },
            });

            it("accepts entries that reference an SD-JWT VC query", () => {
                expect(
                    service.validate(
                        withTransactionData([entry(["pid"])]),
                        undefined,
                    ),
                ).toEqual([]);
            });

            it("reports entries that name ids outside the DCQL query", () => {
                expect(
                    service.validate(
                        withTransactionData([entry(["pid", "iban"])]),
                        undefined,
                    ),
                ).toEqual([
                    expect.objectContaining({
                        severity: "error",
                        code: "TRANSACTION_DATA_UNCHECKABLE",
                        path: "/spec/transaction_data",
                        message:
                            "transaction_data[0].credential_ids names ids that are not in the DCQL query: iban",
                        resource: { kind: "PresentationConfig", id: "pid" },
                    }),
                ]);
            });

            it("leaves malformed credential queries to the schema", () => {
                const document = withTransactionData([entry(["pid"])]);
                const issues = service.validate(
                    {
                        ...document,
                        spec: {
                            ...document.spec,
                            dcql_query: { credentials: [{ id: "pid" }] },
                        },
                    },
                    undefined,
                );
                expect(
                    issues.some(
                        (issue) =>
                            issue.code === "TRANSACTION_DATA_UNCHECKABLE",
                    ),
                ).toBe(false);
            });

            it("leaves malformed entries to the schema", () => {
                const issues = service.validate(
                    withTransactionData([{ type: "x", credential_ids: "pid" }]),
                    undefined,
                );
                expect(
                    issues.some(
                        (issue) =>
                            issue.code === "TRANSACTION_DATA_UNCHECKABLE",
                    ),
                ).toBe(false);
            });
        });

        describe("imported registration certificates", () => {
            const unsignedJwt = (payload: Record<string, unknown>) => {
                const encode = (value: unknown) =>
                    Buffer.from(JSON.stringify(value)).toString("base64url");
                return `${encode({ alg: "none" })}.${encode(payload)}.`;
            };
            const withCertificate = (
                registration_cert: unknown,
                vct = "<TENANT_URL>/credentials/pid",
            ) => {
                const document = presentation([
                    { type: "etsi_tl", values: [{ trustListId: "pid" }] },
                ]);
                const credential = document.spec.dcql_query.credentials[0];
                credential.meta = { vct_values: [vct] };
                return {
                    ...document,
                    spec: { ...document.spec, registration_cert },
                };
            };
            const certificate = (vct: string, exp?: number) =>
                unsignedJwt({
                    ...(exp === undefined ? {} : { exp }),
                    credentials: [
                        { format: "dc+sd-jwt", meta: { vct_values: [vct] } },
                    ],
                });
            const tenantVct =
                "https://eudiplo.example/issuers/acme/credentials/pid";

            afterEach(() => {
                skipOveraskingCheck.value = false;
            });

            it("accepts a certificate covering the query with <TENANT_URL> resolved for the tenant", () => {
                expect(
                    service.validateRegistrationCertificate(
                        withCertificate({ jwt: certificate(tenantVct) }),
                        "acme",
                        undefined,
                    ),
                ).toEqual([]);
            });

            it("reports a certificate for another tenant", () => {
                expect(
                    service.validateRegistrationCertificate(
                        withCertificate({ jwt: certificate(tenantVct) }),
                        "other",
                        undefined,
                    ),
                ).toEqual([
                    {
                        severity: "error",
                        code: "REGISTRATION_CERTIFICATE_REFUSED",
                        path: "/spec/registration_cert",
                        message:
                            "Registration certificate does not authorize the requested DCQL credentials",
                        resource: { kind: "PresentationConfig", id: "pid" },
                    },
                ]);
            });

            it("reports a certificate issued to another relying party than the access certificate's", async () => {
                const crypto = webcrypto as Crypto;
                const algorithm = {
                    name: "ECDSA",
                    namedCurve: "P-256",
                    hash: "SHA-256",
                };
                const keys = (await crypto.subtle.generateKey(algorithm, true, [
                    "sign",
                    "verify",
                ])) as CryptoKeyPair;
                const accessCertificate = (
                    await x509.X509CertificateGenerator.createSelfSigned(
                        {
                            serialNumber: "01",
                            name: "CN=Acme, 2.5.4.97=VATDE-123456789",
                            notBefore: new Date(Date.now() - 60_000),
                            notAfter: new Date(Date.now() + 3_600_000),
                            signingAlgorithm: algorithm,
                            keys,
                        },
                        crypto,
                    )
                ).toString("pem");
                const issuedTo = (id: string) =>
                    withCertificate({
                        jwt: unsignedJwt({
                            sub: { id },
                            credentials: [
                                {
                                    format: "dc+sd-jwt",
                                    meta: { vct_values: [tenantVct] },
                                },
                            ],
                        }),
                    });

                expect(
                    service.validateRegistrationCertificate(
                        issuedTo("VATDE-123456789"),
                        "acme",
                        undefined,
                        accessCertificate,
                    ),
                ).toEqual([]);
                expect(
                    service.validateRegistrationCertificate(
                        issuedTo("VATDE-999"),
                        "acme",
                        undefined,
                        accessCertificate,
                    ),
                ).toEqual([
                    expect.objectContaining({
                        code: "REGISTRATION_CERTIFICATE_REFUSED",
                        message: expect.stringContaining(
                            "does not belong to the access certificate",
                        ),
                    }),
                ]);
            });

            it("reports an expired certificate even with SKIP_OVERASKING_CHECK", () => {
                skipOveraskingCheck.value = true;
                expect(
                    service.validateRegistrationCertificate(
                        withCertificate({
                            jwt: certificate("urn:other", 1_000),
                        }),
                        "acme",
                        undefined,
                    ),
                ).toEqual([
                    expect.objectContaining({
                        code: "REGISTRATION_CERTIFICATE_REFUSED",
                        message: "Registration certificate is expired",
                    }),
                ]);
            });

            it("leaves malformed fields to the schema check", () => {
                const {
                    spec: { registration_cert: _, ...spec },
                    ...document
                } = withCertificate(undefined);
                expect(
                    service.validateRegistrationCertificate(
                        {
                            ...document,
                            spec: { ...spec, registration_cert: { jwt: 42 } },
                        },
                        "acme",
                        undefined,
                    ),
                ).toEqual([]);
            });

            it("leaves an unresolved placeholder to SECRET_REQUIRED", () => {
                expect(
                    service.validateRegistrationCertificate(
                        withCertificate({ jwt: "${RC_JWT}" }),
                        "acme",
                        undefined,
                    ),
                ).toEqual([]);
                expect(
                    service.validateRegistrationCertificate(
                        withCertificate({ jwt: "${RC_JWT}" }),
                        "acme",
                        new Set(["/registration_cert/jwt"]),
                    ),
                ).toEqual([]);
            });

            it("checks the text of an escaped form as a certificate", () => {
                // Read from "$${RC_JWT}": no placeholder at that path.
                expect(
                    service.validateRegistrationCertificate(
                        withCertificate({ jwt: "${RC_JWT}" }),
                        "acme",
                        new Set(),
                    ),
                ).toEqual([
                    expect.objectContaining({
                        code: "REGISTRATION_CERTIFICATE_REFUSED",
                    }),
                ]);
            });

            it("is not part of the document checks, so skipped documents pass", () => {
                expect(
                    service.validate(
                        withCertificate({ jwt: certificate(tenantVct, 1_000) }),
                        undefined,
                    ),
                ).toEqual([]);
            });
        });
    });
});
