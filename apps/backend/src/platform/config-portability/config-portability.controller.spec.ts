import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import type { AuditLogService } from "../../audit-log/audit-log.service.js";
import type { TokenPayload } from "../../auth/token.decorator.js";
import type { ConfigBundleService } from "./config-bundle.service.js";
import type { ConfigBundleApplyService } from "./config-bundle-apply.service.js";
import type { ConfigBundleArchiveService } from "./config-bundle-archive.service.js";
import type { ConfigFolderBundleService } from "./config-folder-bundle.service.js";
import type { ConfigImportJournalService } from "./config-import-journal.service.js";
import type { ConfigMigrationService } from "./config-migration.service.js";
import type { ConfigOwnershipService } from "./config-ownership.service.js";
import { ConfigPortabilityController } from "./config-portability.controller.js";
import type { ConfigBundle } from "./config-resource.types.js";

const fingerprint = "a".repeat(64);
const token = {
    entity: { type: "tenant", id: "demo" },
    client: { clientId: "demo-admin" },
    roles: ["tenant:admin"],
} as unknown as TokenPayload;
const request = { headers: {} } as Request;

function createController(result: object) {
    const auditLog = { record: vi.fn().mockResolvedValue(undefined) };
    const folder = { reattach: vi.fn().mockResolvedValue(result) };
    const apply = { apply: vi.fn().mockResolvedValue(result) };
    const controller = new ConfigPortabilityController(
        {} as ConfigBundleService,
        {} as ConfigBundleArchiveService,
        apply as unknown as ConfigBundleApplyService,
        {} as ConfigMigrationService,
        {} as ConfigOwnershipService,
        auditLog as unknown as AuditLogService,
        {} as ConfigImportJournalService,
        folder as unknown as ConfigFolderBundleService,
    );
    return { controller, auditLog };
}

describe("ConfigPortabilityController reattach", () => {
    it("records the client that got a generated secret, never the secret", async () => {
        const { controller, auditLog } = createController({
            items: [{ kind: "Client", id: "folder-client", action: "update" }],
            generatedSecrets: [
                {
                    kind: "Client",
                    id: "folder-client",
                    path: "/spec/secret",
                    value: "generated-secret-value",
                },
            ],
        });

        await controller.reattach(
            token,
            request,
            "Client",
            "folder-client",
            fingerprint,
        );

        expect(auditLog.record).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: "demo",
                actionType: "config_client_secret_generated",
                after: { clients: ["folder-client"], count: 1 },
            }),
        );
        expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain(
            "generated-secret-value",
        );
    });

    it("records no generated secret when reattach generated none", async () => {
        const { controller, auditLog } = createController({
            items: [
                {
                    kind: "PresentationConfig",
                    id: "age-check",
                    action: "update",
                },
            ],
        });

        await controller.reattach(
            token,
            request,
            "PresentationConfig",
            "age-check",
            fingerprint,
        );

        expect(auditLog.record).toHaveBeenCalledOnce();
        expect(auditLog.record).toHaveBeenCalledWith(
            expect.objectContaining({
                actionType: "config_resource_reattached",
            }),
        );
    });
});

describe("ConfigPortabilityController import", () => {
    it("records the client that got a generated secret, never the secret", async () => {
        const { controller, auditLog } = createController({
            items: [{ kind: "Client", id: "bundle-client", action: "create" }],
            generatedSecrets: [
                {
                    kind: "Client",
                    id: "bundle-client",
                    path: "/spec/secret",
                    value: "generated-secret-value",
                },
            ],
        });

        await controller.import(
            token,
            request,
            {} as ConfigBundle,
            "upsert",
            undefined,
            fingerprint,
        );

        expect(auditLog.record).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: "demo",
                actionType: "config_client_secret_generated",
                after: { clients: ["bundle-client"], count: 1 },
            }),
        );
        expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain(
            "generated-secret-value",
        );
    });
});

describe("ConfigPortabilityController document export", () => {
    function createExporter(exportDocument: ReturnType<typeof vi.fn>) {
        const auditLog = { record: vi.fn().mockResolvedValue(undefined) };
        const controller = new ConfigPortabilityController(
            { exportDocument } as unknown as ConfigBundleService,
            {} as ConfigBundleArchiveService,
            {} as ConfigBundleApplyService,
            {} as ConfigMigrationService,
            {} as ConfigOwnershipService,
            auditLog as unknown as AuditLogService,
            {} as ConfigImportJournalService,
            {} as ConfigFolderBundleService,
        );
        return { controller, auditLog };
    }

    it("records the exported kind and ID, never the document", async () => {
        const document = { $schema: "s", spec: { id: "pid", secret: "x" } };
        const { controller, auditLog } = createExporter(
            vi.fn().mockResolvedValue(document),
        );

        await expect(
            controller.exportDocument(
                token,
                request,
                "CredentialConfig",
                "pid",
            ),
        ).resolves.toBe(document);

        expect(auditLog.record).toHaveBeenCalledOnce();
        expect(auditLog.record).toHaveBeenCalledWith(
            expect.objectContaining({
                tenantId: "demo",
                actionType: "config_resource_exported",
                after: { kind: "CredentialConfig", id: "pid" },
            }),
        );
    });

    it("records nothing when the export fails", async () => {
        const { controller, auditLog } = createExporter(
            vi.fn().mockRejectedValue(new Error("not found")),
        );

        await expect(
            controller.exportDocument(token, request, "CredentialConfig", "x"),
        ).rejects.toThrow("not found");
        expect(auditLog.record).not.toHaveBeenCalled();
    });

    it("refuses a key chain without an admin role and records nothing", async () => {
        const exportDocument = vi.fn();
        const { controller, auditLog } = createExporter(exportDocument);
        const keyManager = {
            ...token,
            roles: ["keys:manage"],
        } as unknown as TokenPayload;

        await expect(
            controller.exportDocument(keyManager, request, "KeyChain", "key"),
        ).rejects.toThrow("private keys");
        expect(exportDocument).not.toHaveBeenCalled();
        expect(auditLog.record).not.toHaveBeenCalled();
    });
});
