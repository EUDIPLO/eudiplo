import { BadRequestException, ForbiddenException } from "@nestjs/common";
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
    const issuedCredentials = {
        revokeIssuedUnder: vi.fn().mockResolvedValue(0),
    };
    const auditLog = { record: vi.fn() };
    const service = new CredentialConfigService(
        repository as never,
        { find: vi.fn() } as never,
        { replaceUriWithPublicUrl: vi.fn() } as never,
        {} as never,
        { register: vi.fn() } as never,
        { getPresentationConfig: vi.fn() } as never,
        auditLog as never,
        issuedCredentials,
    );
    return { service, repository, issuedCredentials, auditLog };
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

describe("CredentialConfigService disclosure policy change revocation", () => {
    const oldPolicy = { policy: "allowList", values: ["https://rp-a.example"] };
    const newPolicy = { policy: "allowList", values: ["https://rp-b.example"] };
    const revokeOption = { revokeOnDisclosurePolicyChange: true };

    test("revokes nothing without the opt-in, even when the policy changes", async () => {
        const { service, repository, issuedCredentials } = setup({
            embeddedDisclosurePolicy: oldPolicy,
        });
        await service.update("tenant", "pid", {
            embeddedDisclosurePolicy: newPolicy,
        } as never);
        expect(repository.save).toHaveBeenCalledOnce();
        expect(issuedCredentials.revokeIssuedUnder).not.toHaveBeenCalled();
    });

    test.each([
        ["the update leaves the policy out", { description: "updated" }],
        [
            "the same policy is set again",
            { embeddedDisclosurePolicy: oldPolicy },
        ],
    ])("revokes nothing with the opt-in when %s", async (_case, update) => {
        const { service, repository, issuedCredentials } = setup({
            embeddedDisclosurePolicy: oldPolicy,
        });
        await service.update(
            "tenant",
            "pid",
            update as never,
            undefined,
            undefined,
            revokeOption,
        );
        expect(repository.save).toHaveBeenCalledOnce();
        expect(issuedCredentials.revokeIssuedUnder).not.toHaveBeenCalled();
    });

    test.each([
        ["added", null, newPolicy],
        ["changed", oldPolicy, newPolicy],
        ["deleted", oldPolicy, null],
    ])(
        "revokes the tenant's credentials of the configuration when the policy is %s",
        async (_case, stored, requested) => {
            const { service, repository, issuedCredentials } = setup({
                embeddedDisclosurePolicy: stored,
            });
            const order: string[] = [];
            issuedCredentials.revokeIssuedUnder.mockImplementation(async () => {
                order.push("revoke");
                return 1;
            });
            repository.save.mockImplementation(async (config: unknown) => {
                order.push("save");
                return config;
            });
            await service.update(
                "tenant",
                "pid",
                { embeddedDisclosurePolicy: requested } as never,
                undefined,
                undefined,
                revokeOption,
            );
            expect(issuedCredentials.revokeIssuedUnder).toHaveBeenCalledWith(
                "tenant",
                "pid",
            );
            // Before the new policy is stored, and once more for credentials
            // issued while it was stored.
            expect(order).toEqual(["revoke", "save", "revoke"]);
        },
    );

    test("keeps the old policy when revoking fails", async () => {
        const { service, repository, issuedCredentials } = setup({
            embeddedDisclosurePolicy: oldPolicy,
        });
        issuedCredentials.revokeIssuedUnder.mockRejectedValue(
            new Error("unavailable"),
        );
        await expect(
            service.update(
                "tenant",
                "pid",
                { embeddedDisclosurePolicy: newPolicy } as never,
                undefined,
                undefined,
                revokeOption,
            ),
        ).rejects.toThrow("unavailable");
        expect(repository.save).not.toHaveBeenCalled();
    });

    test("keeps the stored update and its audit record when the revocation after storing fails", async () => {
        const { service, repository, issuedCredentials, auditLog } = setup({
            embeddedDisclosurePolicy: oldPolicy,
        });
        issuedCredentials.revokeIssuedUnder
            .mockResolvedValueOnce(2)
            .mockRejectedValueOnce(new Error("unavailable"));
        await service.update(
            "tenant",
            "pid",
            { embeddedDisclosurePolicy: newPolicy } as never,
            { subject: "admin" } as never,
            undefined,
            revokeOption,
        );
        expect(repository.save).toHaveBeenCalledOnce();
        expect(auditLog.record).toHaveBeenCalledOnce();
    });

    test("refuses a client limited to other configurations, changing nothing", async () => {
        const { service, repository, issuedCredentials } = setup({
            embeddedDisclosurePolicy: oldPolicy,
        });
        await expect(
            service.update(
                "tenant",
                "pid",
                { embeddedDisclosurePolicy: newPolicy } as never,
                undefined,
                undefined,
                { ...revokeOption, allowedCredentialConfigurationIds: ["mdl"] },
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(repository.save).not.toHaveBeenCalled();
        expect(issuedCredentials.revokeIssuedUnder).not.toHaveBeenCalled();
    });

    test("lets a client limited to the configuration revoke", async () => {
        const { service, issuedCredentials } = setup({
            embeddedDisclosurePolicy: oldPolicy,
        });
        await service.update(
            "tenant",
            "pid",
            { embeddedDisclosurePolicy: newPolicy } as never,
            undefined,
            undefined,
            { ...revokeOption, allowedCredentialConfigurationIds: ["pid"] },
        );
        expect(issuedCredentials.revokeIssuedUnder).toHaveBeenCalledTimes(2);
    });
});
