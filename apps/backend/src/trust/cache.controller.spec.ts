import { describe, expect, it, vi } from "vitest";
import { CacheController } from "./cache.controller.js";
import type { FederationTrustService } from "./federation-trust.service.js";
import type { StatusListVerifierService } from "./status-list-verifier.service.js";
import type { TrustStoreService } from "./trust-store.service.js";

function createController() {
    const trustStoreService = { clearCache: vi.fn() };
    const statusListVerifierService = { clearCache: vi.fn() };
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
    it("clears the trust list, federation trust and status list caches", () => {
        const {
            controller,
            trustStoreService,
            statusListVerifierService,
            federationTrustService,
        } = createController();

        controller.clearAllCaches();

        expect(trustStoreService.clearCache).toHaveBeenCalledTimes(1);
        expect(federationTrustService.clearTrustCache).toHaveBeenCalledTimes(1);
        expect(statusListVerifierService.clearCache).toHaveBeenCalledTimes(1);
    });

    it("clears the federation trust cache together with the trust list cache", () => {
        const {
            controller,
            trustStoreService,
            statusListVerifierService,
            federationTrustService,
        } = createController();

        controller.clearTrustListCache();

        expect(trustStoreService.clearCache).toHaveBeenCalledTimes(1);
        expect(federationTrustService.clearTrustCache).toHaveBeenCalledTimes(1);
        expect(statusListVerifierService.clearCache).not.toHaveBeenCalled();
    });

    it("leaves the trust caches alone when clearing the status list cache", () => {
        const {
            controller,
            trustStoreService,
            statusListVerifierService,
            federationTrustService,
        } = createController();

        controller.clearStatusListCache();

        expect(statusListVerifierService.clearCache).toHaveBeenCalledTimes(1);
        expect(trustStoreService.clearCache).not.toHaveBeenCalled();
        expect(federationTrustService.clearTrustCache).not.toHaveBeenCalled();
    });
});
