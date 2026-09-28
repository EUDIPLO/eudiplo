import type { AuthorizationServerMetadata } from "@openid4vc/oauth2";
import { describe, expect, it, vi } from "vitest";
import type { IssuanceConfiguration } from "../../../configuration/issuance/domain/issuance-configuration.js";
import { AuthorizationServerNotTrusted } from "../domain/authorization-server-errors.js";
import { BuildIssuerMetadata } from "./build-issuer-metadata.js";

const base = "https://issuer.example/issuers/tenant";

function setup(config: Partial<IssuanceConfiguration>) {
    const hosted = {
        get: vi.fn(
            async (_tenantId: string, server: { kind: string }) =>
                ({ issuer: server.kind }) as AuthorizationServerMetadata,
        ),
    };
    const external = {
        resolve: vi.fn(
            async (issuer: string) =>
                ({ issuer }) as AuthorizationServerMetadata,
        ),
    };
    const certificates = { resolve: vi.fn(async () => "registration-jwt") };
    const createCredentialIssuerMetadata = vi.fn((metadata) => metadata);
    const useCase = new BuildIssuerMetadata(
        {
            getForTenant: async () =>
                ({
                    authorizationServers: [],
                    display: [],
                    ...config,
                }) as IssuanceConfiguration,
        },
        hosted,
        external,
        {
            credentialConfigurationsSupported: async () => ({
                pid: { format: "dc+sd-jwt" } as never,
            }),
            credentialRequestEncryptionKey: async () => ({ kid: "enc" }),
        },
        certificates,
        "https://issuer.example",
    );
    const run = () =>
        useCase.execute("tenant", { createCredentialIssuerMetadata });
    return { run, hosted, external, certificates };
}

describe("BuildIssuerMetadata", () => {
    it("lists enabled authorization servers in order without duplicates", async () => {
        const federation = {
            mode: "hybrid",
            trustAnchors: [{ entityId: "https://anchor" }],
        };
        const { run, external, hosted } = setup({
            federation: federation as never,
            authorizationServers: [
                { type: "external", id: "a", issuer: "https://as.example" },
                { type: "built-in", id: "b" },
                { type: "oid4vp", id: "vp", enabled: false },
                { type: "external", id: "dup", issuer: "https://as.example" },
                { type: "chained", id: "c", upstream: {} },
                { type: "chained", id: "incomplete" },
            ] as never,
        });

        const result = await run();

        expect(result.credentialIssuer.authorization_servers).toEqual([
            "https://as.example",
            base,
            `${base}/chained-as`,
        ]);
        expect(result.authorizationServers.map((s) => s.issuer)).toEqual([
            "https://as.example",
            "built-in",
            "chained-as",
        ]);
        expect(external.resolve).toHaveBeenCalledOnce();
        expect(external.resolve).toHaveBeenCalledWith(
            "https://as.example",
            expect.objectContaining({ trustAnchors: federation.trustAnchors }),
        );
        expect(hosted.get).toHaveBeenCalledTimes(2);
    });

    it("advertises endpoints, encryption and optional features from the configuration", async () => {
        const { run, certificates } = setup({
            batchSize: 3,
            credentialRequestEncryption: true,
            notificationEndpointEnabled: false,
            registrationCertificate: { enabled: true, mode: "generate" },
        });

        const { credentialIssuer } = await run();

        expect(credentialIssuer).toMatchObject({
            credential_issuer: base,
            credential_endpoint: `${base}/vci/credential`,
            deferred_credential_endpoint: `${base}/vci/deferred_credential`,
            nonce_endpoint: `${base}/vci/nonce`,
            notification_endpoint: undefined,
            credential_configurations_supported: {
                pid: { format: "dc+sd-jwt" },
            },
            credential_request_encryption: {
                jwks: { keys: [{ kid: "enc" }] },
                encryption_required: true,
            },
            credential_response_encryption: { encryption_required: false },
            batch_credential_issuance: { batch_size: 3 },
            issuer_info: [
                { format: "registration_cert", data: "registration-jwt" },
            ],
        });
        expect(certificates.resolve).toHaveBeenCalledWith("tenant", {
            enabled: true,
            mode: "generate",
        });
    });

    it("omits optional features and skips disabled registration certificates", async () => {
        const { run, certificates } = setup({
            batchSize: 1,
            registrationCertificate: { enabled: false },
        });

        const { credentialIssuer } = await run();

        expect(credentialIssuer.notification_endpoint).toBe(
            `${base}/vci/notification`,
        );
        expect(credentialIssuer.batch_credential_issuance).toBeUndefined();
        expect(credentialIssuer.issuer_info).toBeUndefined();
        expect(certificates.resolve).not.toHaveBeenCalled();
    });

    it("propagates an untrusted external authorization server", async () => {
        const { run, external } = setup({
            authorizationServers: [
                { type: "external", id: "a", issuer: "https://as.example" },
            ] as never,
        });
        external.resolve.mockRejectedValue(
            new AuthorizationServerNotTrusted("no chain"),
        );

        await expect(run()).rejects.toThrow(
            "Authorization server is not trusted by OpenID Federation policy: no chain",
        );
    });
});
