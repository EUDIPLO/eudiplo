import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import { describe, expect, it } from "vitest";
import { CreateRegistrarConfigSchema } from "../../registrar/schemas/registrar.schema.js";
import { ConfigBundleService } from "./config-bundle.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type {
    ConfigBundleRequirement,
    ConfigDocument,
    ConfigResourceKind,
} from "./config-resource.types.js";
import { documentSourceHash } from "./config-source-hash.js";

describe("ConfigBundleService secret handling", () => {
    const service = Object.create(
        ConfigBundleService.prototype,
    ) as ConfigBundleService;
    Reflect.set(service, "registry", new ConfigResourceRegistry());

    it("replaces every registered KMS credential with a requirement", () => {
        const requirements: ConfigBundleRequirement[] = [];
        const redact = Reflect.get(service, "redact") as (
            kind: ConfigResourceKind,
            id: string,
            value: unknown,
            requirements: ConfigBundleRequirement[],
        ) => unknown;
        const output = redact.call(
            service,
            "KmsConfig",
            "kms",
            {
                providers: [
                    {
                        id: "vault",
                        vaultToken: "vault-secret",
                        secretAccessKey: "aws-secret",
                        pin: "pkcs11-secret",
                        clientSecret: "csc-client-secret",
                        sad: "csc-sad",
                        authorizeAuthData: [{ name: "otp", value: "123456" }],
                        auth: {
                            token: "bearer-secret",
                            clientSecret: "oauth-secret",
                        },
                    },
                ],
            },
            requirements,
        ) as Record<string, unknown>;

        expect(JSON.stringify(output)).not.toContain("vault-secret");
        expect(JSON.stringify(output)).not.toContain("aws-secret");
        expect(JSON.stringify(output)).not.toContain("pkcs11-secret");
        expect(JSON.stringify(output)).not.toContain("csc-client-secret");
        expect(JSON.stringify(output)).not.toContain("csc-sad");
        expect(JSON.stringify(output)).not.toContain("123456");
        expect(JSON.stringify(output)).not.toContain("bearer-secret");
        expect(JSON.stringify(output)).not.toContain("oauth-secret");
        expect(requirements).toHaveLength(8);
        expect(
            requirements.every(({ code }) => code === "SECRET_REQUIRED"),
        ).toBe(true);
    });

    it("replaces upstream client secrets of chained authorization servers with a requirement", () => {
        const requirements: ConfigBundleRequirement[] = [];
        const redact = Reflect.get(service, "redact") as (
            kind: ConfigResourceKind,
            id: string,
            value: unknown,
            requirements: ConfigBundleRequirement[],
        ) => unknown;

        const output = redact.call(
            service,
            "IssuanceConfig",
            "issuance",
            {
                authorizationServers: [
                    { type: "built-in", id: "built-in" },
                    {
                        type: "chained",
                        id: "chained",
                        upstream: {
                            issuer: "https://idp.example",
                            clientId: "c",
                            clientSecret: "upstream-secret",
                        },
                    },
                ],
            },
            requirements,
        ) as { authorizationServers: { upstream?: unknown }[] };

        expect(output.authorizationServers[1].upstream).toEqual({
            issuer: "https://idp.example",
            clientId: "c",
            clientSecret:
                "${ISSUANCECONFIG_ISSUANCE_AUTHORIZATIONSERVERS_1_UPSTREAM_CLIENTSECRET}",
        });
        expect(requirements).toMatchObject([
            {
                code: "SECRET_REQUIRED",
                path: "/spec/authorizationServers/1/upstream/clientSecret",
            },
        ]);
    });

    it("exports a registrar configuration without client secret without requiring one", async () => {
        const requirements: ConfigBundleRequirement[] = [];
        const documents: ConfigDocument[] = [];
        const canonicalEntitySpec = Reflect.get(
            service,
            "canonicalEntitySpec",
        ) as (
            kind: ConfigResourceKind,
            entity: Record<string, unknown>,
        ) => Record<string, unknown>;
        const addDocument = Reflect.get(service, "addDocument") as (
            documents: ConfigDocument[],
            requirements: ConfigBundleRequirement[],
            tenantId: string,
            kind: ConfigResourceKind,
            id: string,
            rawSpec: Record<string, unknown>,
        ) => Promise<void>;
        Reflect.set(service, "ownershipService", {
            get: async () => ({ generation: 1, ownership: "unmanaged" }),
        });

        await addDocument.call(
            service,
            documents,
            requirements,
            "tenant",
            "RegistrarConfig",
            "registrar",
            canonicalEntitySpec.call(service, "RegistrarConfig", {
                registrarUrl: "https://registrar.example/api",
                oidcUrl: "https://auth.example/realms/registrar",
                clientId: "client",
                clientSecret: null,
                username: "user",
                password: "registrar-password",
                registrationCertificateDefaults: null,
                relyingPartyContact: null,
            }),
        );

        const { spec } = documents[0];
        expect(spec).not.toHaveProperty("clientSecret");
        expect(spec).not.toHaveProperty("registrationCertificateDefaults");
        expect(spec).not.toHaveProperty("relyingPartyContact");
        expect(spec.password).toBe("${REGISTRARCONFIG_REGISTRAR_PASSWORD}");
        expect(requirements).toMatchObject([
            { code: "SECRET_REQUIRED", path: "/spec/password" },
        ]);
        expect(
            CreateRegistrarConfigSchema.safeParse({
                ...spec,
                password: "supplied",
            }).success,
        ).toBe(true);
    });

    it("exports the relying party contact of a registrar configuration", () => {
        const canonicalEntitySpec = Reflect.get(
            service,
            "canonicalEntitySpec",
        ) as (
            kind: ConfigResourceKind,
            entity: Record<string, unknown>,
        ) => Record<string, unknown>;
        const contact = { email: "support@verifier.example" };

        const spec = canonicalEntitySpec.call(service, "RegistrarConfig", {
            registrarUrl: "https://registrar.example/api",
            oidcUrl: "https://auth.example/realms/registrar",
            clientId: "client",
            username: "user",
            password: "registrar-password",
            relyingPartyContact: contact,
        });

        expect(spec.relyingPartyContact).toEqual(contact);
        expect(CreateRegistrarConfigSchema.safeParse(spec).success).toBe(true);
    });

    it("removes private parameters from exported public JWKs", () => {
        const toPublicJwk = Reflect.get(service, "toPublicJwk") as (
            value: unknown,
        ) => Record<string, unknown>;

        expect(
            toPublicJwk.call(service, {
                kty: "EC",
                crv: "P-256",
                x: "public-x",
                y: "public-y",
                d: "private-d",
                k: "private-k",
            }),
        ).toEqual({
            kty: "EC",
            crv: "P-256",
            x: "public-x",
            y: "public-y",
        });
    });
});

describe("ConfigBundleService issuance export", () => {
    const service = Object.create(
        ConfigBundleService.prototype,
    ) as ConfigBundleService;

    it("does not export the removed 'vp' option of chained authorization servers", () => {
        const canonicalEntitySpec = Reflect.get(
            service,
            "canonicalEntitySpec",
        ) as (
            kind: ConfigResourceKind,
            entity: Record<string, unknown>,
        ) => Record<string, unknown>;
        const upstream = { issuer: "https://idp.example", clientId: "c" };

        const spec = canonicalEntitySpec.call(service, "IssuanceConfig", {
            authorizationServers: [
                { type: "built-in", id: "built-in" },
                {
                    type: "chained",
                    id: "legacy-vp",
                    vp: { enabled: true, presentationConfigId: "pid" },
                },
                {
                    type: "chained",
                    id: "chained",
                    upstream,
                    vp: { enabled: false, presentationConfigId: "pid" },
                },
            ],
        });

        expect(spec.authorizationServers).toEqual([
            { type: "built-in", id: "built-in" },
            { type: "chained", id: "chained", upstream },
        ]);
    });

    it("leaves out unset fields whose schema does not accept null", () => {
        const canonicalEntitySpec = Reflect.get(
            service,
            "canonicalEntitySpec",
        ) as (
            kind: ConfigResourceKind,
            entity: Record<string, unknown>,
        ) => Record<string, unknown>;

        const spec = canonicalEntitySpec.call(service, "IssuanceConfig", {
            authorizationServers: [{ type: "built-in", id: "built-in" }],
            walletProviderTrustLists: null,
            federation: null,
            registrationCertificate: null,
            display: null,
            txCodeMaxAttempts: null,
            walletAttestationStatusCheckMode: null,
        });

        for (const field of ["walletProviderTrustLists", "display"]) {
            expect(spec[field], field).toBeUndefined();
        }
        // Their schema accepts null, and applying null clears them.
        expect(spec).toMatchObject({
            federation: null,
            registrationCertificate: null,
            txCodeMaxAttempts: null,
            walletAttestationStatusCheckMode: null,
        });
        expect(
            canonicalEntitySpec.call(service, "IssuanceConfig", {
                authorizationServers: [],
                walletAttestationStatusCheckMode: "strict",
            }).walletAttestationStatusCheckMode,
        ).toBe("strict");
    });
});

describe("ConfigBundleService status list export", () => {
    const service = Object.create(
        ConfigBundleService.prototype,
    ) as ConfigBundleService;
    const statusListSpec = Reflect.get(service, "statusListSpec") as (
        statusList: Record<string, unknown>,
    ) => Record<string, unknown>;
    const list = {
        id: "list",
        credentialConfigurationId: null,
        elements: [0, 1, 2],
        bits: 1,
    };

    it("exports the key chain of a list that has its own", () => {
        expect(
            statusListSpec.call(service, { ...list, keyChainId: "signer" }),
        ).toMatchObject({ keyChainId: "signer", capacity: 3 });
    });

    it("leaves out the key chain of a list without its own", () => {
        expect(
            statusListSpec.call(service, { ...list, keyChainId: null })
                .keyChainId,
        ).toBeUndefined();
    });
});

describe("ConfigBundleService plans for documents applied as they are", () => {
    const client: ConfigDocument = {
        $schema: schemaUrl("Client"),
        kind: "Client",
        metadata: { generation: 1 },
        spec: { clientId: "app", secret: "!generate" },
    };
    const metadata = {
        ownership: "file-managed" as const,
        source: "folder:/config/demo",
        sourceHash: documentSourceHash(client),
    };
    const skipsComparison = (oidc?: string) => {
        const service = Object.create(
            ConfigBundleService.prototype,
        ) as ConfigBundleService;
        Reflect.set(service, "configService", { get: () => oidc });
        return (
            Reflect.get(service, "skipsComparison") as (
                document: ConfigDocument,
                applied: typeof metadata,
                source: string,
            ) => boolean
        ).call(service, client, metadata, "folder:/config/demo");
    };

    it("keeps a generated-secret client applied as it is", () => {
        expect(skipsComparison()).toBe(true);
    });

    it("applies it again with Keycloak, which the plan cannot compare", () => {
        expect(skipsComparison("https://idp.example/realms/eudiplo")).toBe(
            false,
        );
    });
});
