import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { expect, it } from "vitest";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { KeyChainEntity } from "../../src/crypto/key/entities/key-chain.entity.js";
import { AttributeProviderEntity } from "../../src/issuer/configuration/attribute-provider/entities/attribute-provider.entity.js";
import { TypeOrmCredentialConfigurationRepository } from "../../src/issuer/configuration/credentials/adapters/typeorm-credential-configuration.repository.js";
import { TypeOrmCredentialConfigRepository } from "../../src/issuer/configuration/credentials/credential-config/adapters/typeorm-credential-config.repository.js";
import { CredentialConfig } from "../../src/issuer/configuration/credentials/entities/credential.entity.js";
import { endpointEntities } from "./endpoint-repository.contract.js";

export const credentialEntities = [
    ...endpointEntities,
    CredentialConfig,
    KeyChainEntity,
];
export function credentialRepositoryContract(database: () => DataSource) {
    it("shares scoped configuration reads across management and issuance", async () => {
        const db = database();
        const tenantId = randomUUID();
        const other = randomUUID();
        const id = randomUUID();
        await db
            .getRepository(TenantEntity)
            .save([{ id: tenantId }, { id: other }]);
        const management = new TypeOrmCredentialConfigRepository(
            db.getRepository(CredentialConfig),
        );
        const issuance = new TypeOrmCredentialConfigurationRepository(
            db.getRepository(CredentialConfig),
            db.getRepository(AttributeProviderEntity),
        );
        await management.save({
            tenantId,
            id,
            config: { format: "dc+sd-jwt", display: [] },
            fields: [],
            description: "original",
            vct: "urn:pid",
            embeddedDisclosurePolicy: { policy: "none" },
        });
        await management.save({
            tenantId: other,
            id,
            config: { format: "mso_mdoc", display: [], docType: "pid" },
            fields: [],
        });
        const config = await issuance.getForTenant(tenantId, id);
        expect(config.constructor).toBe(Object);
        for (const relation of [
            "tenant",
            "keyChain",
            "attributeProvider",
            "webhookEndpoint",
        ])
            expect(config).not.toHaveProperty(relation);
        expect(config).toMatchObject({
            vct: "urn:pid",
            embeddedDisclosurePolicy: { policy: "none" },
        });
        expect(await management.getForTenant(tenantId, id)).toEqual(config);
        expect(await management.listForTenant(tenantId)).toEqual([config]);
        expect(await issuance.listForTenant(tenantId, [id, "missing"])).toEqual(
            [config],
        );
        expect(await issuance.listForTenant(tenantId, [])).toEqual([]);
        await management.save({ ...config, description: null });
        expect(await issuance.getForTenant(tenantId, id)).toMatchObject({
            description: null,
            vct: "urn:pid",
        });
        expect(await issuance.getForTenant(other, id)).toMatchObject({
            config: { format: "mso_mdoc" },
        });
        await management.deleteForTenant(tenantId, id);
        await management.deleteForTenant(tenantId, id);
        expect(await issuance.findForTenant(tenantId, id)).toBeNull();
        await expect(issuance.getForTenant(tenantId, id)).rejects.toMatchObject(
            { name: "CredentialConfigurationNotFound" },
        );
        await expect(
            management.getForTenant(tenantId, id),
        ).rejects.toMatchObject({ name: "CredentialConfigurationNotFound" });
        expect(await issuance.findForTenant(other, id)).not.toBeNull();
        await db
            .getRepository(TenantEntity)
            .delete([{ id: tenantId }, { id: other }]);
    });
}
