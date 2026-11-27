import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { expect, it } from "vitest";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { KeyChainEntity } from "../../src/crypto/key/entities/key-chain.entity.js";
import { TypeOrmCredentialConfigurationRepository } from "../../src/issuer/configuration/credentials/adapters/typeorm-credential-configuration.repository.js";
import { CredentialConfig } from "../../src/issuer/configuration/credentials/entities/credential.entity.js";
import { ResourceIdTaken } from "../../src/shared/domain/conflict-error.js";
import { endpointEntities } from "./endpoint-repository.contract.js";

export const credentialEntities = [
    ...endpointEntities,
    CredentialConfig,
    KeyChainEntity,
];
export function credentialRepositoryContract(database: () => DataSource) {
    it("stores, reads and deletes configurations within the tenant scope", async () => {
        const db = database();
        const tenantId = randomUUID();
        const other = randomUUID();
        const id = randomUUID();
        await db
            .getRepository(TenantEntity)
            .save([{ id: tenantId }, { id: other }]);
        const repository = new TypeOrmCredentialConfigurationRepository(
            db.getRepository(CredentialConfig),
        );
        const saved = await repository.save({
            tenantId,
            id,
            config: { format: "dc+sd-jwt", display: [] },
            fields: [],
            description: "original",
            vct: "urn:pid",
            embeddedDisclosurePolicy: { policy: "none" },
        });
        await repository.save({
            tenantId: other,
            id,
            config: { format: "mso_mdoc", display: [], docType: "pid" },
            fields: [],
        });
        const config = await repository.getForTenant(tenantId, id);
        expect(config.constructor).toBe(Object);
        for (const relation of [
            "tenant",
            "keyChain",
            "attributeProvider",
            "webhookEndpoint",
        ]) {
            expect(config).not.toHaveProperty(relation);
            expect(saved).not.toHaveProperty(relation);
        }
        expect(config).toMatchObject({
            vct: "urn:pid",
            embeddedDisclosurePolicy: { policy: "none" },
        });
        expect(await repository.findForTenant(tenantId, id)).toEqual(config);
        expect(await repository.listForTenant(tenantId)).toEqual([config]);
        expect(
            await repository.listForTenant(tenantId, [id, "missing"]),
        ).toEqual([config]);
        expect(await repository.listForTenant(tenantId, [])).toEqual([]);
        await repository.save({ ...config, description: null });
        expect(await repository.getForTenant(tenantId, id)).toMatchObject({
            description: null,
            vct: "urn:pid",
        });
        expect(await repository.getForTenant(other, id)).toMatchObject({
            config: { format: "mso_mdoc" },
        });
        await repository.deleteForTenant(tenantId, id);
        await repository.deleteForTenant(tenantId, id);
        expect(await repository.findForTenant(tenantId, id)).toBeNull();
        expect(await repository.listForTenant(tenantId)).toEqual([]);
        await expect(
            repository.getForTenant(tenantId, id),
        ).rejects.toMatchObject({ name: "CredentialConfigurationNotFound" });
        expect(await repository.findForTenant(other, id)).not.toBeNull();
        await db
            .getRepository(TenantEntity)
            .delete([{ id: tenantId }, { id: other }]);
    });

    it("creates a configuration once and refuses a second create of the same ID", async () => {
        const db = database();
        const tenantId = randomUUID();
        const other = randomUUID();
        const id = randomUUID();
        await db
            .getRepository(TenantEntity)
            .save([{ id: tenantId }, { id: other }]);
        const repository = new TypeOrmCredentialConfigurationRepository(
            db.getRepository(CredentialConfig),
        );
        const config = {
            id,
            config: { format: "dc+sd-jwt" as const, display: [] },
            fields: [],
        };
        expect(await repository.existsForTenant(tenantId, id)).toBe(false);
        const created = await repository.create({
            ...config,
            tenantId,
            description: "first",
        });
        expect(created.constructor).toBe(Object);
        expect(created).not.toHaveProperty("tenant");
        expect(await repository.existsForTenant(tenantId, id)).toBe(true);

        await expect(
            repository.create({ ...config, tenantId, description: "second" }),
        ).rejects.toThrow(new ResourceIdTaken("Credential configuration", id));
        expect(await repository.getForTenant(tenantId, id)).toMatchObject({
            description: "first",
        });
        // The same ID in another tenant is free.
        await repository.create({ ...config, tenantId: other });
        expect(await repository.existsForTenant(other, id)).toBe(true);
        await db
            .getRepository(TenantEntity)
            .delete([{ id: tenantId }, { id: other }]);
    });
}
