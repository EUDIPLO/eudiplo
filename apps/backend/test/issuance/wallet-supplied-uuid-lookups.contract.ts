import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { beforeEach, describe, expect, it } from "vitest";
import { ClientEntity } from "../../src/auth/client/entities/client.entity.js";
import { TenantEntity } from "../../src/auth/tenant/entities/tenant.entity.js";
import { TypeOrmDeferredTransactionRepository } from "../../src/issuer/issuance/oid4vci/adapters/typeorm-deferred-transaction.repository.js";
import { TypeOrmChainedAsSessionRepository } from "../../src/issuer/issuance/oid4vci/authorization/adapters/typeorm-chained-as-session.repository.js";
import { TypeOrmInteractiveAuthSessionRepository } from "../../src/issuer/issuance/oid4vci/authorization/adapters/typeorm-interactive-auth-session.repository.js";
import { ChainedAsSessionStatus } from "../../src/issuer/issuance/oid4vci/authorization/domain/chained-as-session.js";
import { ChainedAsSessionEntity } from "../../src/issuer/issuance/oid4vci/authorization/shared/entities/chained-as-session.entity.js";
import { DeferredTransactionStatus } from "../../src/issuer/issuance/oid4vci/domain/deferred-transaction-status.js";
import { DeferredTransactionEntity } from "../../src/issuer/issuance/oid4vci/entities/deferred-transaction.entity.js";
import { InteractiveAuthSessionEntity } from "../../src/issuer/issuance/oid4vci/entities/interactive-auth-session.entity.js";

export const walletSuppliedUuidEntities = [
    TenantEntity,
    ClientEntity,
    DeferredTransactionEntity,
    ChainedAsSessionEntity,
    InteractiveAuthSessionEntity,
];

/**
 * Identifiers a wallet may send that are not UUIDs: 16 random bytes in
 * base64url (as other issuers use), an empty string and a UUID with a suffix.
 */
const notUuids = ["q2X9b3pTQ0uV5n8yZk1wAg", "", `${randomUUID()}x`];

/**
 * Wallet-supplied identifiers that are looked up in `uuid` columns (deferred
 * `transaction_id`, chained AS `request_uri`, IAE `auth_session`). PostgreSQL
 * refuses a value that is not a UUID for such a column, SQLite stores it as
 * text; on both, the lookup must answer "not found" instead of throwing.
 */
export function walletSuppliedUuidLookupsContract(
    getDataSource: () => DataSource,
) {
    describe("wallet-supplied identifiers in uuid columns", () => {
        const tenantId = "uuid-lookups-tenant";

        beforeEach(async () => {
            const db = getDataSource();
            await db.getRepository(DeferredTransactionEntity).clear();
            await db.getRepository(ChainedAsSessionEntity).clear();
            await db.getRepository(InteractiveAuthSessionEntity).clear();
            await db.getRepository(TenantEntity).save({ id: tenantId });
        });

        describe("deferred transactions", () => {
            const repository = () =>
                new TypeOrmDeferredTransactionRepository(
                    getDataSource().getRepository(DeferredTransactionEntity),
                );

            it.each(notUuids)(
                "treats transaction_id %j as unknown",
                async (transactionId) => {
                    const transactions = repository();
                    await expect(
                        transactions.find(tenantId, transactionId),
                    ).resolves.toBeNull();
                    await expect(
                        transactions.findPending(tenantId, transactionId),
                    ).resolves.toBeNull();
                    await expect(
                        transactions.markRetrieved(tenantId, transactionId),
                    ).resolves.toBe(false);
                    await expect(
                        transactions.markExpired(tenantId, transactionId),
                    ).resolves.toBeUndefined();
                },
            );

            it("still finds a stored transaction by its UUID", async () => {
                const transactions = repository();
                const transactionId = randomUUID();
                await transactions.create({
                    transactionId,
                    tenantId,
                    sessionId: randomUUID(),
                    credentialConfigurationId: "pid",
                    holderCnf: { kty: "EC" },
                    status: DeferredTransactionStatus.Pending,
                    interval: 5,
                    expiresAt: new Date(Date.now() + 60_000),
                });
                await expect(
                    transactions.find(tenantId, transactionId),
                ).resolves.toMatchObject({ transactionId, tenantId });
                await expect(
                    transactions.findPending(tenantId, transactionId),
                ).resolves.toMatchObject({ transactionId });
                await transactions.markReady(tenantId, transactionId, "vc");
                await expect(
                    transactions.markRetrieved(tenantId, transactionId),
                ).resolves.toBe(true);
            });
        });

        describe("chained AS sessions", () => {
            it.each(notUuids)(
                "treats request_uri session ID %j as unknown",
                async (id) => {
                    const sessions = new TypeOrmChainedAsSessionRepository(
                        getDataSource().getRepository(ChainedAsSessionEntity),
                    );
                    await expect(
                        sessions.findForTenant(
                            tenantId,
                            id,
                            ChainedAsSessionStatus.PENDING_AUTHORIZE,
                        ),
                    ).resolves.toBeNull();
                },
            );

            it("still finds a stored session by its UUID", async () => {
                const sessions = new TypeOrmChainedAsSessionRepository(
                    getDataSource().getRepository(ChainedAsSessionEntity),
                );
                const id = randomUUID();
                await sessions.save(
                    sessions.create({
                        id,
                        tenantId,
                        status: ChainedAsSessionStatus.PENDING_AUTHORIZE,
                        issuerState: randomUUID(),
                        clientId: "wallet",
                        redirectUri: "https://wallet.example/cb",
                        expiresAt: new Date(Date.now() + 60_000),
                    }),
                );
                await expect(
                    sessions.findForTenant(
                        tenantId,
                        id,
                        ChainedAsSessionStatus.PENDING_AUTHORIZE,
                    ),
                ).resolves.toMatchObject({ id, tenantId });
            });
        });

        describe("interactive authorization sessions", () => {
            it("still finds and updates a stored session by its UUID", async () => {
                const sessions = new TypeOrmInteractiveAuthSessionRepository(
                    getDataSource().getRepository(InteractiveAuthSessionEntity),
                );
                const authSession = randomUUID();
                await sessions.create({
                    authSession,
                    tenantId,
                    clientId: "wallet",
                    interactionTypesSupported: "openid4vp_presentation",
                    status: "pending",
                    currentStepIndex: 0,
                    expiresAt: new Date(Date.now() + 60_000),
                });
                await expect(
                    sessions.findForTenant(tenantId, authSession),
                ).resolves.toMatchObject({ authSession, tenantId });
                await expect(
                    sessions.updateForTenant(tenantId, authSession, {
                        status: "web_auth_completed",
                    }),
                ).resolves.toBe(true);
            });

            it.each(notUuids)(
                "treats auth_session %j as unknown",
                async (authSession) => {
                    const sessions =
                        new TypeOrmInteractiveAuthSessionRepository(
                            getDataSource().getRepository(
                                InteractiveAuthSessionEntity,
                            ),
                        );
                    await expect(
                        sessions.findForTenant(tenantId, authSession),
                    ).resolves.toBeNull();
                    await expect(
                        sessions.updateForTenant(tenantId, authSession, {
                            status: "web_auth_completed",
                        }),
                    ).resolves.toBe(false);
                },
            );
        });
    });
}
