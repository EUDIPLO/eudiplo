import { describe, expect, test, vi } from "vitest";
import { MAX_STATUS_LIST_CAPACITY } from "../../shared/domain/status-list-capacity.js";
import { StatusListConfigService } from "./status-list-config.service.js";

describe("StatusListConfigService.updateConfig", () => {
    const setup = () => {
        const tenantRepository = {
            findOneByOrFail: vi.fn().mockResolvedValue({
                id: "tenant-1",
                statusListConfig: undefined,
            }),
            update: vi.fn().mockResolvedValue(undefined),
        };
        const service = new StatusListConfigService(
            tenantRepository as never,
            {} as never,
            { record: vi.fn() } as never,
        );
        return { service, tenantRepository };
    };

    test.each([MAX_STATUS_LIST_CAPACITY + 1, Number.MAX_SAFE_INTEGER])(
        "refuses a default capacity of %s without storing it",
        async (capacity) => {
            const { service, tenantRepository } = setup();
            await expect(
                service.updateConfig("tenant-1", { capacity }),
            ).rejects.toMatchObject({ status: 400 });
            expect(tenantRepository.update).not.toHaveBeenCalled();
        },
    );

    test("stores a default capacity at the limit", async () => {
        const { service, tenantRepository } = setup();
        await service.updateConfig("tenant-1", {
            capacity: MAX_STATUS_LIST_CAPACITY,
        });
        expect(tenantRepository.update).toHaveBeenCalledWith(
            { id: "tenant-1" },
            {
                statusListConfig: expect.objectContaining({
                    capacity: MAX_STATUS_LIST_CAPACITY,
                }),
            },
        );
    });
});
