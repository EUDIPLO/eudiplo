import { HttpStatus, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { MediaType } from "../../../../shared/utils/media-type/media-type.enum.js";
import { IssuanceConfigurationNotFound } from "../../../configuration/issuance/domain/issuance-configuration.js";
import { WellKnownException } from "../exceptions/index.js";
import { WellKnownService } from "./well-known.service.js";

function wellKnown(issuanceConfig: object) {
    const keyChainService = {
        getAccessTokenVerificationKeys: vi.fn(
            async (_tenant, keyId: string | undefined) => [
                { kty: "EC", kid: keyId ?? "authorization-server" },
            ],
        ),
    };
    const service = Object.assign(Object.create(WellKnownService.prototype), {
        issuanceService: {
            getIssuanceConfiguration: vi.fn().mockResolvedValue(issuanceConfig),
        },
        keyChainService,
    }) as WellKnownService;
    return { service, keyChainService };
}

describe("WellKnownService JWKS of the built-in authorization server", () => {
    it("publishes the keys of the key chain the built-in server names", async () => {
        const { service, keyChainService } = wellKnown({
            authorizationServers: [
                {
                    type: "built-in",
                    id: "built-in",
                    token: { signingKeyId: "as-key", lifetimeSeconds: 900 },
                },
            ],
        });

        await expect(service.getJwks("tenant-1")).resolves.toEqual({
            keys: [{ kty: "EC", kid: "as-key" }],
        });
        expect(
            keyChainService.getAccessTokenVerificationKeys,
        ).toHaveBeenCalledWith("tenant-1", "as-key", 900);
    });

    it("falls back to the tenant's authorization server key chain", async () => {
        const { service, keyChainService } = wellKnown({
            authorizationServers: [{ type: "built-in", id: "built-in" }],
        });

        await expect(service.getJwks("tenant-1")).resolves.toEqual({
            keys: [{ kty: "EC", kid: "authorization-server" }],
        });
        expect(
            keyChainService.getAccessTokenVerificationKeys,
        ).toHaveBeenCalledWith("tenant-1", undefined, 300);
    });
});

describe("WellKnownService for a tenant without Issuer Settings", () => {
    function failing(error: Error) {
        const reject = vi.fn().mockRejectedValue(error);
        return Object.assign(Object.create(WellKnownService.prototype), {
            buildIssuerMetadata: { execute: reject },
            sdk: { issuer: vi.fn() },
            issuanceService: { getIssuanceConfiguration: reject },
            authorizeService: { authzMetadata: reject },
            chainedAsService: { getMetadata: reject, getJwks: reject },
            authorizationServersService: {
                getMetadata: reject,
                getJwks: reject,
            },
        }) as WellKnownService;
    }

    const handlers: [string, (s: WellKnownService) => Promise<unknown>][] = [
        [
            "issuer metadata",
            (s) => s.getIssuerMetadata("verifier", MediaType.APPLICATION_JSON),
        ],
        [
            "authorization server metadata",
            (s) => s.getAuthzMetadata("verifier"),
        ],
        ["JWKS", (s) => s.getJwks("verifier")],
        ["Chained AS metadata", (s) => s.getChainedAsMetadata("verifier")],
        ["Chained AS JWKS", (s) => s.getChainedAsJwks("verifier")],
        [
            "managed authorization server metadata",
            (s) => s.getManagedAuthorizationServerMetadata("verifier", "as"),
        ],
        [
            "managed authorization server JWKS",
            (s) => s.getManagedAuthorizationServerJwks("verifier", "as"),
        ],
    ];

    it.each(handlers)(
        "answers 404 for the %s of a tenant that does not issue",
        async (_name, call) => {
            const error = await call(
                failing(new IssuanceConfigurationNotFound("verifier")),
            ).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(WellKnownException);
            expect((error as WellKnownException).getStatus()).toBe(404);
        },
    );

    it.each(handlers)(
        "still answers 500 when the %s of an issuing tenant cannot be built",
        async (_name, call) => {
            const error = await call(
                failing(new Error("missing required vct")),
            ).catch((e: unknown) => e);

            expect((error as WellKnownException).getStatus()).toBe(500);
        },
    );

    it("keeps the message in the well_known_error body", async () => {
        const error = await failing(
            new IssuanceConfigurationNotFound("verifier"),
        )
            .getIssuerMetadata("verifier", MediaType.APPLICATION_JSON)
            .catch((e: unknown) => e);

        expect((error as WellKnownException).getResponse()).toEqual({
            error: "well_known_error",
            error_description:
                "Failed to retrieve issuer metadata for tenant verifier: Issuance configuration for tenant 'verifier' not found",
        });
    });

    it("still answers 500 when the signing key chain of an issuing tenant is missing", async () => {
        const service = Object.assign(
            Object.create(WellKnownService.prototype),
            {
                buildIssuerMetadata: {
                    execute: vi.fn().mockResolvedValue({
                        credentialIssuer: {
                            credential_issuer: "https://issuer",
                        },
                    }),
                },
                sdk: { issuer: vi.fn() },
                certService: {
                    find: vi
                        .fn()
                        .mockRejectedValue(
                            new NotFoundException(
                                "No key chain found with usage type 'access'",
                            ),
                        ),
                },
            },
        ) as WellKnownService;

        const error = await service
            .getIssuerMetadata("issuer", MediaType.APPLICATION_JWT)
            .catch((e: unknown) => e);

        expect((error as WellKnownException).getStatus()).toBe(500);
    });

    it("passes a WellKnownException through unchanged", async () => {
        const original = new WellKnownException("gone", HttpStatus.GONE);

        const error = await failing(original)
            .getJwks("issuer")
            .catch((e: unknown) => e);

        expect(error).toBe(original);
    });
});
