import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AttributeProviderReferences } from "./application/attribute-provider-references.js";
import { AttributeProviderController } from "./attribute-provider.controller.js";
import { AttributeProviderService } from "./attribute-provider.service.js";
import type { AttributeProviderReference } from "./domain/attribute-provider-reference.js";
import { AttributeProviderInUseError } from "./domain/attribute-provider-reference.js";

const provider = {
    id: "crm",
    tenantId: "acme",
    name: "CRM",
    url: "https://crm.example",
    auth: { type: "none" },
};

function setup(references: AttributeProviderReference[] = []) {
    const repo = {
        listForTenant: vi.fn(),
        findForTenant: vi.fn().mockResolvedValue(provider),
        save: vi.fn(),
        deleteForTenant: vi.fn(),
    };
    const registry = new AttributeProviderReferences();
    const source = { findReferences: vi.fn().mockResolvedValue(references) };
    registry.register(source);
    const auditLog = { record: vi.fn() };
    const service = new AttributeProviderService(
        repo as any,
        {} as any,
        { register: vi.fn() } as any,
        auditLog as any,
        {} as any,
        registry,
    );
    return { service, repo, source, auditLog };
}

const pid: AttributeProviderReference = {
    kind: "CredentialConfig",
    id: "pid",
    description: "PID",
};
const mdl: AttributeProviderReference = { kind: "CredentialConfig", id: "mdl" };

describe("AttributeProviderService delete", () => {
    it("deletes a provider no credential config names", async () => {
        const { service, repo, source } = setup();

        await service.delete("acme", "crm");

        expect(source.findReferences).toHaveBeenCalledWith("acme", "crm");
        expect(repo.deleteForTenant).toHaveBeenCalledWith("acme", "crm");
    });

    it("refuses a provider credential configs name, deleting nothing", async () => {
        const { service, repo, auditLog } = setup([pid, mdl]);

        const error = await service
            .delete("acme", "crm", { sub: "admin" } as any)
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(AttributeProviderInUseError);
        expect((error as AttributeProviderInUseError).references).toEqual([
            pid,
            mdl,
        ]);
        expect((error as Error).message).toBe(
            'Attribute provider "crm" is still used by 2 credential configs ("pid", "mdl"). Remove these references before deleting the attribute provider.',
        );
        expect(repo.deleteForTenant).not.toHaveBeenCalled();
        expect(auditLog.record).not.toHaveBeenCalled();
    });

    it("uses the singular for one credential config", async () => {
        const { service } = setup([pid]);

        await expect(service.delete("acme", "crm")).rejects.toThrow(
            'Attribute provider "crm" is still used by 1 credential config ("pid").',
        );
    });

    it("deletes nothing when the reference lookup fails", async () => {
        const { service, repo, source } = setup();
        source.findReferences.mockRejectedValue(new Error("database down"));

        await expect(service.delete("acme", "crm")).rejects.toThrow(
            "database down",
        );
        expect(repo.deleteForTenant).not.toHaveBeenCalled();
    });

    it("skips the check for a configuration import", async () => {
        const { service, repo, source } = setup([pid]);

        await service.delete("acme", "crm", undefined, undefined, {
            checkReferences: false,
        });

        expect(source.findReferences).not.toHaveBeenCalled();
        expect(repo.deleteForTenant).toHaveBeenCalledWith("acme", "crm");
    });

    it("answers 404 for an unknown provider before looking for references", async () => {
        const { service, repo, source } = setup([pid]);
        repo.findForTenant.mockResolvedValue(null);

        await expect(service.delete("acme", "crm")).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(source.findReferences).not.toHaveBeenCalled();
    });
});

describe("AttributeProviderController delete", () => {
    it("maps a provider in use to 409 with code and references", async () => {
        const { service } = setup([pid]);
        const controller = new AttributeProviderController(service);

        const error = await controller
            .delete("crm", { entity: { id: "acme" } } as any, {} as any)
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({
            code: "ATTRIBUTE_PROVIDER_IN_USE",
            message:
                'Attribute provider "crm" is still used by 1 credential config ("pid"). Remove these references before deleting the attribute provider.',
            references: [pid],
        });
    });
});
