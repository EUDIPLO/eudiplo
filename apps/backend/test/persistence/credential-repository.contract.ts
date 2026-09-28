import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { expect, it } from "vitest";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { KeyChainEntity } from "../../src/crypto/key/entities/key-chain.entity.js";
import { TypeOrmCredentialConfigurationRepository } from "../../src/issuer/configuration/credentials/adapters/typeorm-credential-configuration.repository.js";
import { CredentialConfig } from "../../src/issuer/configuration/credentials/entities/credential.entity.js";
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
}
