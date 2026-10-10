import { describe, expect, it } from "vitest";
import { ConfigBundleService } from "./config-bundle.service.js";
import { ConfigResourceRegistry } from "./config-resource.registry.js";
import type {
    ConfigBundleRequirement,
    ConfigResourceKind,
} from "./config-resource.types.js";

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
});
