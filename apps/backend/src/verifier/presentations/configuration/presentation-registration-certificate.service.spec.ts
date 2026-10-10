import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PresentationConfig } from "../entities/presentation-config.entity.js";
import { PresentationRegistrationCertificateService } from "./presentation-registration-certificate.service.js";

function createService(registrar: Record<string, unknown> = {}) {
    const repository = {
        update: vi.fn().mockResolvedValue(undefined),
        findOneBy: vi.fn(),
        save: vi.fn().mockResolvedValue(undefined),
    };
    const registrarService = {
        isEnabledForTenant: vi.fn().mockResolvedValue(true),
        computeDcqlFingerprint: vi.fn().mockReturnValue("dcql-fp"),
        computeSpecFingerprint: vi.fn().mockReturnValue("spec-fp"),
        computeAuthorizedCredentialsFingerprint: vi
            .fn()
            .mockReturnValue("cred-fp"),
        resolveRegistrationCertificate: vi.fn().mockResolvedValue({
            jwt: "fresh-jwt",
            payload: { credentials: [], iat: 100, exp: 9_999_999_999 },
            source: "registrar",
        }),
        ...registrar,
    };
    const logger = { setContext: vi.fn(), warn: vi.fn() };
    const service = new PresentationRegistrationCertificateService(
        repository as any,
        registrarService as any,
        { publicUrl: "https://eudiplo.example", skipTrustAuthority: false },
        logger as any,
    );
    return { service, repository, registrarService, logger };
}

function config(overrides: Partial<PresentationConfig> = {}) {
    return {
        id: "config",
        tenantId: "tenant",
        dcql_query: { credentials: [{ id: "<TENANT_URL>" }] },
        registration_cert: { body: { privacy_policy: "p" } },
        registrationCertCache: null,
        ...overrides,
    } as unknown as PresentationConfig;
}

const validCache = {
    jwt: "cached-jwt",
    fingerprint: "cred-fp",
    dcqlFingerprint: "dcql-fp",
    specFingerprint: "spec-fp",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    source: "registrar" as const,
};

describe("PresentationRegistrationCertificateService.getOrIssueRegistrationCertificate", () => {
    it("returns nothing without a spec or an enabled registrar", async () => {
        const { service, registrarService } = createService({
            isEnabledForTenant: vi.fn().mockResolvedValue(false),
        });
        await expect(
            service.getOrIssueRegistrationCertificate(
                config({ registration_cert: undefined }),
                {},
                "r",
            ),
        ).resolves.toBeUndefined();
        await expect(
            service.getOrIssueRegistrationCertificate(config(), {}, "r"),
        ).resolves.toBeUndefined();
        expect(
            registrarService.resolveRegistrationCertificate,
        ).not.toHaveBeenCalled();
    });

    it("uses a cache that matches spec, DCQL and is not about to expire", async () => {
        const { service, repository } = createService();
        await expect(
            service.getOrIssueRegistrationCertificate(
                config({ registrationCertCache: validCache }),
                {},
                "r",
            ),
        ).resolves.toBe("cached-jwt");
        expect(repository.update).not.toHaveBeenCalled();
    });

    it.each([
        ["changed DCQL", { dcqlFingerprint: "other" }],
        ["changed spec", { specFingerprint: "other" }],
        [
            "expiry within the skew",
            { expiresAt: Math.floor(Date.now() / 1000) + 30 },
        ],
    ])("reissues and persists the cache on %s", async (_, cacheOverride) => {
        const { service, repository, registrarService } = createService();
        const presentationConfig = config({
            registrationCertCache: { ...validCache, ...cacheOverride },
        });

        await expect(
            service.getOrIssueRegistrationCertificate(
                presentationConfig,
                { resolved: true },
                "request",
            ),
        ).resolves.toBe("fresh-jwt");

        expect(
            registrarService.resolveRegistrationCertificate,
        ).toHaveBeenCalledWith(
            presentationConfig.registration_cert,
            { resolved: true },
            "request",
            "tenant",
            { accessKeyChainId: undefined },
        );
        const newCache = {
            jwt: "fresh-jwt",
            fingerprint: "cred-fp",
            dcqlFingerprint: "dcql-fp",
            specFingerprint: "spec-fp",
            issuedAt: 100,
            expiresAt: 9_999_999_999,
            source: "registrar",
        };
        expect(repository.update).toHaveBeenCalledWith(
            { id: "config", tenantId: "tenant" },
            { registrationCertCache: newCache },
        );
        expect(presentationConfig.registrationCertCache).toEqual(newCache);
    });
});

describe("PresentationRegistrationCertificateService.reissue", () => {
    it("rejects configs without a spec or without an enabled registrar", async () => {
        await expect(
            createService().service.reissue(
                config({ registration_cert: undefined }),
            ),
        ).rejects.toThrow("Presentation config has no registrationCert spec");
        await expect(
            createService({
                isEnabledForTenant: vi.fn().mockResolvedValue(false),
            }).service.reissue(config()),
        ).rejects.toThrow("Registrar is not enabled for this tenant");
    });

    it("bypasses a valid cache, resolves <TENANT_URL> in the DCQL query and passes the access key chain", async () => {
        const { service, registrarService } = createService();
        await service.reissue(
            config({
                registrationCertCache: validCache,
                accessKeyChainId: "access",
            }),
        );

        expect(
            registrarService.resolveRegistrationCertificate,
        ).toHaveBeenCalledWith(
            { body: { privacy_policy: "p" } },
            {
                credentials: [{ id: "https://eudiplo.example/issuers/tenant" }],
            },
            "reissue-config",
            "tenant",
            { accessKeyChainId: "access" },
        );
    });
});

describe("PresentationRegistrationCertificateService.scheduleRefresh", () => {
    it("stores a freshly resolved cache for the latest config", async () => {
        const { service, repository } = createService();
        repository.findOneBy.mockResolvedValue(config());

        service.scheduleRefresh("config", "tenant");

        await vi.waitFor(() => expect(repository.save).toHaveBeenCalled());
        expect(repository.save.mock.calls[0][0].registrationCertCache).toEqual(
            expect.objectContaining({ jwt: "fresh-jwt" }),
        );
    });

    it("clears the cache on registrar failures but logs user-config errors", async () => {
        const failing = createService({
            resolveRegistrationCertificate: vi
                .fn()
                .mockRejectedValue(new Error("network")),
        });
        failing.repository.findOneBy.mockResolvedValue(config());
        failing.service.scheduleRefresh("config", "tenant");
        await vi.waitFor(() =>
            expect(failing.repository.save).toHaveBeenCalled(),
        );
        expect(
            failing.repository.save.mock.calls[0][0].registrationCertCache,
        ).toBeNull();

        const invalid = createService({
            resolveRegistrationCertificate: vi
                .fn()
                .mockRejectedValue(new BadRequestException("bad spec")),
        });
        invalid.repository.findOneBy.mockResolvedValue(config());
        invalid.service.scheduleRefresh("config", "tenant");
        await vi.waitFor(() => expect(invalid.logger.warn).toHaveBeenCalled());
        expect(invalid.repository.save).not.toHaveBeenCalled();
    });
});
