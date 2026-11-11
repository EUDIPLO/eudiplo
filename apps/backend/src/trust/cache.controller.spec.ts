import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { Role } from "../auth/roles/role.enum.js";
import type { TokenPayload } from "../auth/token.decorator.js";
import { CacheController } from "./cache.controller.js";
import type { FederationTrustService } from "./federation-trust.service.js";
import type { StatusListVerifierService } from "./status-list-verifier.service.js";
import type { TrustStoreService } from "./trust-store.service.js";

/** A tenant's caller with `issuance:manage`. */
const tenant = {
    entity: { id: "tenant-a" },
    roles: [Role.Issuances],
} as unknown as TokenPayload;

/** The platform operator, without a tenant. */
const operator = { roles: [Role.Tenants] } as unknown as TokenPayload;

function createController() {
    const trustStoreService = {
        clearCache: vi.fn(),
        forgetSequenceNumbers: vi.fn().mockResolvedValue(undefined),
    };
    const statusListVerifierService = {
        clearCache: vi.fn(),
        clearTenantCache: vi.fn(),
        getCacheStats: vi
            .fn()
            .mockReturnValue({ size: 0, jwtCacheSize: 0, uris: [] }),
    };
    const federationTrustService = { clearTrustCache: vi.fn() };
    const controller = new CacheController(
        trustStoreService as unknown as TrustStoreService,
        statusListVerifierService as unknown as StatusListVerifierService,
        federationTrustService as unknown as FederationTrustService,
    );
    return {
        controller,
        trustStoreService,
        statusListVerifierService,
        federationTrustService,
    };
}

describe("CacheController", () => {
    it("clears the caller tenant's trust list, federation trust and status list entries", () => {
        const {
            controller,
            trustStoreService,
            statusListVerifierService,
            federationTrustService,
        } = createController();

        controller.clearAllCaches(tenant);

        expect(trustStoreService.clearCache).toHaveBeenCalledWith("tenant-a");
        expect(federationTrustService.clearTrustCache).toHaveBeenCalledWith(
            "tenant-a",
        );
        expect(statusListVerifierService.clearTenantCache).toHaveBeenCalledWith(
            "tenant-a",
        );
        expect(statusListVerifierService.clearCache).not.toHaveBeenCalled();
    });

    it("clears the caches of all tenants for tenants:manage", () => {
        const {
            controller,
            trustStoreService,
            statusListVerifierService,
            federationTrustService,
        } = createController();

        controller.clearAllCaches(operator);

        expect(trustStoreService.clearCache).toHaveBeenCalledWith(undefined);
        expect(federationTrustService.clearTrustCache).toHaveBeenCalledWith(
            undefined,
        );
        expect(statusListVerifierService.clearCache).toHaveBeenCalledWith();
        expect(
            statusListVerifierService.clearTenantCache,
        ).not.toHaveBeenCalled();
    });

    it("refuses a caller without tenants:manage and without a tenant", () => {
        const { controller, trustStoreService } = createController();
        const tenantless = { roles: [Role.Issuances] } as TokenPayload;

        expect(() => controller.clearAllCaches(tenantless)).toThrow(
            ForbiddenException,
        );
        expect(() => controller.getStats(tenantless)).toThrow(
            ForbiddenException,
        );
        expect(trustStoreService.clearCache).not.toHaveBeenCalled();
    });

    it("clears the federation trust cache together with the trust list cache", () => {
        const {
            controller,
            trustStoreService,
            statusListVerifierService,
            federationTrustService,
        } = createController();

        controller.clearTrustListCache(tenant);

        expect(trustStoreService.clearCache).toHaveBeenCalledWith("tenant-a");
        expect(federationTrustService.clearTrustCache).toHaveBeenCalledWith(
            "tenant-a",
        );
        expect(statusListVerifierService.clearCache).not.toHaveBeenCalled();
        expect(
            statusListVerifierService.clearTenantCache,
        ).not.toHaveBeenCalled();
    });

    it("keeps the remembered sequence numbers when clearing caches", () => {
        const { controller, trustStoreService } = createController();

        controller.clearAllCaches(tenant);
        controller.clearTrustListCache(tenant);

        expect(trustStoreService.forgetSequenceNumbers).not.toHaveBeenCalled();
    });

    it("forgets the sequence numbers of the caller's tenant", async () => {
        const { controller, trustStoreService, federationTrustService } =
            createController();

        await controller.forgetTrustListSequenceNumbers(tenant);

        expect(trustStoreService.forgetSequenceNumbers).toHaveBeenCalledWith(
            "tenant-a",
        );
        expect(federationTrustService.clearTrustCache).not.toHaveBeenCalled();
    });

    it("leaves the trust caches alone when clearing the status list cache", () => {
        const {
            controller,
            trustStoreService,
            statusListVerifierService,
            federationTrustService,
        } = createController();

        controller.clearStatusListCache(tenant);

        expect(statusListVerifierService.clearTenantCache).toHaveBeenCalledWith(
            "tenant-a",
        );
        expect(trustStoreService.clearCache).not.toHaveBeenCalled();
        expect(federationTrustService.clearTrustCache).not.toHaveBeenCalled();
    });

    it("reports the status lists of the caller's tenant, or of all for tenants:manage", () => {
        const { controller, statusListVerifierService } = createController();

        controller.getStats(tenant);
        controller.getStats(operator);

        expect(statusListVerifierService.getCacheStats.mock.calls).toEqual([
            ["tenant-a"],
            [undefined],
        ]);
    });
});
