import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { Role } from "../../auth/roles/role.enum.js";
import { RolesGuard } from "../../auth/roles/roles.guard.js";
import type { TokenPayload } from "../../auth/token.decorator.js";
import { KeyChainEntity } from "./entities/key-chain.entity.js";
import { KeyChainController } from "./key-chain.controller.js";
import { KeyChainService } from "./key-chain.service.js";
import { KeyUsageType } from "./types/key-usage-type.js";

const privateJwk = {
    kty: "EC",
    crv: "P-256",
    x: "pmn8SKQKZ0t2zFlrUXzJaJwwQ0WnQxcSYoS_D6ZSGho",
    y: "rMd9JTAovcOI_OvOXWCWZ1yVZieVYK2UgvB2IPuSk2o",
    d: "rqv47L1jWkbFAGMCK8TORQ1FknBUYGY6OLU1dYHNDqU",
    kid: "key-active",
    alg: "ES256",
};

function keyChain(overrides: Partial<KeyChainEntity>): KeyChainEntity {
    return Object.assign(new KeyChainEntity(), {
        id: "key",
        tenantId: "tenant",
        usageType: KeyUsageType.Attestation,
        kmsProvider: "db",
        activeJwk: privateJwk,
        activeCertificate: "",
        rotationEnabled: false,
        ...overrides,
    });
}

function serviceFor(entity: KeyChainEntity, providerType: string) {
    const service = Object.create(KeyChainService.prototype) as any;
    service.keyChainRepository = {
        findOne: vi.fn().mockResolvedValue(entity),
    };
    service.kmsRegistry = { resolve: () => ({ type: providerType }) };
    service.certBuilder = { splitPemChain: (pem: string) => [pem] };
    return service as KeyChainService;
}

describe("KeyChainService.export", () => {
    it("exports the private key of a database-held key chain", async () => {
        const service = serviceFor(keyChain({}), "db");

        const exported = await service.export("tenant", "key");

        expect(exported.key.d).toBe(privateJwk.d);
    });

    it("never exports private material of an external KMS key chain", async () => {
        // The entity only stores the public JWK for external providers; a
        // private component must still never be returned if one is present.
        const service = serviceFor(
            keyChain({
                kmsProvider: "vault",
                externalKeyId: "vault-key",
                activeJwk: privateJwk,
            }),
            "vault",
        );

        const exported = await service.export("tenant", "key");

        expect(exported.key).not.toHaveProperty("d");
        expect(exported.key.x).toBe(privateJwk.x);
        expect(exported.kmsProvider).toBe("vault");
    });

    it("strips private material when the provider is not a database provider", async () => {
        const service = serviceFor(
            keyChain({ kmsProvider: "hsm", activeJwk: privateJwk }),
            "pkcs11",
        );

        const exported = await service.export("tenant", "key");

        expect(exported.key).not.toHaveProperty("d");
    });

    it("scopes the lookup to the tenant", async () => {
        const service = serviceFor(keyChain({}), "db") as any;

        await service.export("tenant", "key");

        expect(service.keyChainRepository.findOne).toHaveBeenCalledWith({
            where: { tenantId: "tenant", id: "key" },
        });
    });
});

describe("KeyChainController authorization", () => {
    const guard = new RolesGuard(new Reflector());
    const context = (handler: (...args: never[]) => unknown, roles: Role[]) =>
        ({
            getHandler: () => handler,
            getClass: () => KeyChainController,
            switchToHttp: () => ({ getRequest: () => ({ user: { roles } }) }),
        }) as unknown as ExecutionContext;

    // Endpoints returning private keys or KMS provider credentials.
    const privileged = {
        export: KeyChainController.prototype.export,
        getTenantKmsConfig: KeyChainController.prototype.getTenantKmsConfig,
        updateTenantKmsConfig:
            KeyChainController.prototype.updateTenantKmsConfig,
        deleteTenantKmsConfig:
            KeyChainController.prototype.deleteTenantKmsConfig,
    };

    describe.each(Object.entries(privileged))("%s", (_, handler) => {
        it.each([
            [Role.Issuances],
            [Role.Presentations],
            [Role.Issuances, Role.Presentations, Role.Clients],
        ])(
            "rejects callers with only key chain management roles (%s)",
            (...roles) => {
                expect(guard.canActivate(context(handler, roles))).toBe(false);
            },
        );

        it.each([Role.TenantAdmin, Role.Tenants])(
            "allows callers with %s",
            (role) => {
                expect(guard.canActivate(context(handler, [role]))).toBe(true);
            },
        );
    });

    it.each([
        KeyChainController.prototype.getById,
        KeyChainController.prototype.getProviders,
        KeyChainController.prototype.getProvidersHealth,
    ])("keeps the management roles for %o", (handler) => {
        expect(guard.canActivate(context(handler, [Role.Issuances]))).toBe(
            true,
        );
    });

    it("requires a tenant context", () => {
        const service = { export: vi.fn() };
        const kms = {
            getTenantConfig: vi.fn(),
            saveTenantConfig: vi.fn(),
            deleteTenantConfig: vi.fn(),
        };
        const controller = new KeyChainController(
            service as unknown as KeyChainService,
            kms as never,
        );
        const token = { roles: [Role.Tenants] } as TokenPayload;

        expect(() => controller.export(token, "key")).toThrow(
            ForbiddenException,
        );
        expect(() => controller.getTenantKmsConfig(token)).toThrow(
            ForbiddenException,
        );
        expect(() =>
            controller.updateTenantKmsConfig(token, { providers: [] } as never),
        ).toThrow(ForbiddenException);
        expect(() => controller.deleteTenantKmsConfig(token)).toThrow(
            ForbiddenException,
        );
        expect(service.export).not.toHaveBeenCalled();
        expect(kms.saveTenantConfig).not.toHaveBeenCalled();
        expect(kms.deleteTenantConfig).not.toHaveBeenCalled();
    });
});
