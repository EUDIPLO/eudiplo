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
    );
    return { service, repository };
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
