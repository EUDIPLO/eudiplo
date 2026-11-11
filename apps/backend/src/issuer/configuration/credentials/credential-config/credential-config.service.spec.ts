import { BadRequestException } from "@nestjs/common";
import { describe, expect, test, vi } from "vitest";
import type { CredentialConfigCreate } from "../dto/credential-config-create.dto.js";
import { CredentialConfigService } from "./credential-config.service.js";

const credentialConfig = {
    id: "pid",
    config: { format: "dc+sd-jwt", display: [] },
    fields: [],
} as unknown as CredentialConfigCreate;

function setup(stored: Record<string, unknown> = {}) {
    const events = { emit: vi.fn() };
    const repository = {
        getForTenant: vi.fn().mockResolvedValue({
            ...credentialConfig,
            tenantId: "tenant",
            statusManagement: false,
            activeCredentials: null,
            ...stored,
        }),
        save: vi.fn(async (config: unknown) => config),
    };
    const service = new CredentialConfigService(
        repository as never,
        { find: vi.fn() } as never,
        { replaceUriWithPublicUrl: vi.fn() } as never,
        {} as never,
        { register: vi.fn() } as never,
        { getPresentationConfig: vi.fn() } as never,
        { record: vi.fn() } as never,
        events as never,
    );
    return { service, repository, events };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error("expected a rejection");
}

function expectPolicyRejected(error: unknown) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
    expect((error as Error).message).toBe(
        "statusManagement must be enabled when activeCredentials is enabled.",
    );
}

describe("CredentialConfigService active credential policy", () => {
    test("rejects creating the policy without status management", async () => {
        const { service, repository } = setup();
        expectPolicyRejected(
            await rejection(
                service.store("tenant", {
                    ...credentialConfig,
                    activeCredentials: { enabled: true },
                }),
            ),
        );
        expect(repository.save).not.toHaveBeenCalled();
    });

    test("creates the policy together with status management", async () => {
        const { service, repository } = setup();
        await service.store("tenant", {
            ...credentialConfig,
            statusManagement: true,
            activeCredentials: { enabled: true },
        });
        expect(repository.save).toHaveBeenCalledOnce();
    });

    test("rejects enabling the policy on a configuration without status management", async () => {
        const { service, repository } = setup();
        expectPolicyRejected(
            await rejection(
                service.update("tenant", "pid", {
                    activeCredentials: { enabled: true },
                }),
            ),
        );
        expect(repository.save).not.toHaveBeenCalled();
    });

    test("rejects disabling status management while the policy is enabled", async () => {
        const { service, repository } = setup({
            statusManagement: true,
            activeCredentials: { enabled: true },
        });
        expectPolicyRejected(
            await rejection(
                service.update("tenant", "pid", { statusManagement: false }),
            ),
        );
        expect(repository.save).not.toHaveBeenCalled();
    });

    test("enables the policy and status management in one update", async () => {
        const { service, repository } = setup();
        await service.update("tenant", "pid", {
            statusManagement: true,
            activeCredentials: { enabled: true },
        });
        expect(repository.save).toHaveBeenCalledOnce();
    });

    test.each([
        ["an unrelated field", { description: "updated" }],
        ["a cleared policy", { activeCredentials: null }],
        ["enabled status management", { statusManagement: true }],
    ])(
        "keeps updating a stored configuration that violates the rule with %s",
        async (_case, update) => {
            const { service, repository } = setup({
                statusManagement: false,
                activeCredentials: { enabled: true },
            });
            await service.update("tenant", "pid", update);
            expect(repository.save).toHaveBeenCalledOnce();
        },
    );
});

describe("CredentialConfigService revokeWithWalletUnit", () => {
    const withKeyAttestations = {
        ...credentialConfig.config,
        keyAttestationsRequired: {},
    } as CredentialConfigCreate["config"];

    test("rejects creating it without status management and key attestations", async () => {
        const { service, repository } = setup();
        const error = await rejection(
            service.store("tenant", {
                ...credentialConfig,
                revokeWithWalletUnit: true,
            }),
        );
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message).toBe(
            "statusManagement must be enabled when revokeWithWalletUnit is enabled. config.keyAttestationsRequired must be set when revokeWithWalletUnit is enabled.",
        );
        expect(repository.save).not.toHaveBeenCalled();
    });

    test("rejects removing the key attestation requirement while it is enabled", async () => {
        const { service, repository } = setup({
            config: withKeyAttestations,
            statusManagement: true,
            revokeWithWalletUnit: true,
        });
        const error = await rejection(
            service.update("tenant", "pid", {
                config: credentialConfig.config,
            }),
        );
        expect((error as Error).message).toBe(
            "config.keyAttestationsRequired must be set when revokeWithWalletUnit is enabled.",
        );
        expect(repository.save).not.toHaveBeenCalled();
    });

    test("enables it on a configuration with status management and key attestations", async () => {
        const { service, repository } = setup({
            config: withKeyAttestations,
            statusManagement: true,
        });
        await service.update("tenant", "pid", { revokeWithWalletUnit: true });
        expect(repository.save).toHaveBeenCalledOnce();
    });
});

describe("CredentialConfigService registration certificate inputs", () => {
    test("publishes a change after storing, updating and deleting", async () => {
        const { service, repository, events } = setup();
        Object.assign(repository, {
            deleteForTenant: vi.fn().mockResolvedValue({ affected: 1 }),
        });

        await service.store("tenant", { ...credentialConfig }, true);
        await service.update("tenant", "pid", {});
        await service.delete("tenant", "pid");

        expect(events.emit).toHaveBeenCalledTimes(3);
        expect(events.emit).toHaveBeenCalledWith(
            "issuer.registration-certificate-inputs.changed",
            { tenantId: "tenant" },
        );
    });
});
