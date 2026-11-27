import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { rolesAllow } from "../../test/roles-guard.js";
import { Role } from "../auth/roles/role.enum.js";
import type { TokenPayload } from "../auth/token.decorator.js";
import { AuditLogController } from "./audit-log.controller.js";
import type { AuditLogService } from "./audit-log.service.js";

const auditor = {
    entity: { id: "tenant-1" },
    roles: [Role.AuditRead],
} as unknown as TokenPayload;
const withoutTenant = { roles: [Role.AuditRead] } as unknown as TokenPayload;

describe("AuditLogController", () => {
    it.each([
        [[Role.AuditRead], true],
        [[Role.Clients], false],
        [[Role.Users], false],
        [[Role.SessionsRead], false],
        [[Role.TenantAdmin], true],
    ])("lets a client with %j read the audit log: %s", (roles, allowed) => {
        for (const handler of [
            "getAuditLogs",
            "searchAuditLogs",
            "getRetention",
        ] as const) {
            expect(rolesAllow(AuditLogController, handler, roles)).toBe(
                allowed,
            );
        }
    });

    it("lists only the caller's tenant", async () => {
        const service = { listByTenant: vi.fn().mockResolvedValue([]) };
        const controller = new AuditLogController(
            service as unknown as AuditLogService,
        );

        await controller.getAuditLogs(auditor, {
            limit: 10,
            actionType: ["tenant_updated"],
        });

        expect(service.listByTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            { actionType: ["tenant_updated"] },
            10,
        );
        expect(() =>
            controller.getAuditLogs(withoutTenant, { limit: 10 }),
        ).toThrow(ForbiddenException);
    });

    it("searches only the caller's tenant", async () => {
        const service = { pageByTenant: vi.fn().mockResolvedValue({}) };
        const controller = new AuditLogController(
            service as unknown as AuditLogService,
        );
        const from = new Date("2026-01-01T00:00:00Z");

        await controller.searchAuditLogs(auditor, {
            page: 2,
            pageSize: 50,
            from,
        });

        expect(service.pageByTenant).toHaveBeenCalledExactlyOnceWith(
            "tenant-1",
            { from },
            2,
            50,
        );
        expect(() =>
            controller.searchAuditLogs(withoutTenant, {
                page: 1,
                pageSize: 25,
            }),
        ).toThrow(ForbiddenException);
    });
});
