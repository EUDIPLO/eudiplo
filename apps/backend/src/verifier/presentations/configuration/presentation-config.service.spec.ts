import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { PresentationConfigService } from "./presentation-config.service.js";

const trustedPid = {
    id: "pid",
    format: "dc+sd-jwt",
    meta: { vct_values: ["urn:eudi:pid:1"] },
    trusted_authorities: [
        { type: "etsi_tl", values: [{ trustListId: "pid-issuers" }] },
    ],
};
const { trusted_authorities: _, ...untrustedPid } = trustedPid;

function setup(
    options: { skipTrustAuthority?: boolean; stored?: unknown[] } = {},
) {
    const repository = {
        save: vi.fn(async (config) => config),
        delete: vi.fn(),
        findOneByOrFail: vi.fn().mockResolvedValue({
            id: "pid",
            tenantId: "tenant",
            dcql_query: { credentials: options.stored ?? [trustedPid] },
        }),
    };
    const configImportService = { importConfigsForTenant: vi.fn() };
    const service = new PresentationConfigService(
        repository as any,
        { scheduleRefresh: vi.fn() } as any,
        configImportService as any,
        { register: vi.fn() } as any,
        {} as any,
        {
            publicUrl: "https://eudiplo.example",
            skipTrustAuthority: options.skipTrustAuthority ?? false,
        },
    );
    return { service, repository, configImportService };
}

describe("PresentationConfigService trusted authorities", () => {
    it("stores a config whose credential queries have trusted_authorities", async () => {
        const { service, repository } = setup();

        await service.storePresentationConfig("tenant", {
            id: "pid",
            dcql_query: { credentials: [trustedPid] },
        } as any);

        expect(repository.save).toHaveBeenCalled();
    });

    it("rejects a new config without trusted_authorities", async () => {
        const { service, repository } = setup();

        await expect(
            service.storePresentationConfig("tenant", {
                id: "pid",
                dcql_query: { credentials: [untrustedPid] },
            } as any),
        ).rejects.toThrow(BadRequestException);
        expect(repository.save).not.toHaveBeenCalled();
    });

    it("rejects an update that leaves a stored config without trusted_authorities", async () => {
        const { service, repository } = setup({ stored: [untrustedPid] });

        await expect(
            service.updatePresentationConfig("pid", "tenant", {
                description: "renamed",
            }),
        ).rejects.toThrow(
            "Credential queries without trusted_authorities: pid.",
        );
        expect(repository.save).not.toHaveBeenCalled();
    });

    it("stores a config without trusted_authorities with SKIP_TRUST_AUTHORITY", async () => {
        const { service, repository } = setup({ skipTrustAuthority: true });

        await service.storePresentationConfig("tenant", {
            id: "pid",
            dcql_query: { credentials: [untrustedPid] },
        } as any);

        expect(repository.save).toHaveBeenCalled();
    });

    it("keeps the stored config when an imported file has no trusted_authorities", async () => {
        const { service, repository, configImportService } = setup();
        await (service as any).importForTenant("tenant");
        const { deleteExisting } =
            configImportService.importConfigsForTenant.mock.calls[0][1];

        await expect(
            deleteExisting("tenant", {
                id: "pid",
                dcql_query: { credentials: [untrustedPid] },
            }),
        ).rejects.toThrow(BadRequestException);
        expect(repository.delete).not.toHaveBeenCalled();
    });
});
