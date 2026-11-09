import { Brackets, LessThanOrEqual, type Repository } from "typeorm";
import { CredentialWalletUnit } from "../../status-list/entities/credential-wallet-unit.entity.js";
import type {
    CredentialBoundToWalletUnit,
    CredentialStatusEntry,
    CredentialWalletUnitStore,
} from "../ports/wallet-unit-revocation.ports.js";

/** Records per delete statement, below the parameter limits of both drivers. */
const DELETE_CHUNK_SIZE = 200;

export class TypeOrmCredentialWalletUnitStore
    implements CredentialWalletUnitStore
{
    constructor(
        private readonly repository: Repository<CredentialWalletUnit>,
    ) {}

    async deleteExpired(now: Date): Promise<void> {
        await this.repository.delete({
            credentialExpiresAt: LessThanOrEqual(now),
        });
    }

    async listStatusLists(
        now: Date,
    ): Promise<{ tenantId: string; uri: string }[]> {
        const rows = await this.repository
            .createQueryBuilder("record")
            .select("record.tenantId", "tenantId")
            .addSelect("record.walletUnitStatusUri", "uri")
            .where(this.notExpired(now))
            .distinct(true)
            .getRawMany<{ tenantId: string; uri: string }>();
        return rows.map((row) => ({ tenantId: row.tenantId, uri: row.uri }));
    }

    async findByStatusList(
        tenantId: string,
        uri: string,
        now: Date,
        page: { after?: CredentialStatusEntry; limit: number },
    ): Promise<CredentialBoundToWalletUnit[]> {
        const query = this.repository
            .createQueryBuilder("record")
            .where("record.tenantId = :tenantId", { tenantId })
            .andWhere("record.walletUnitStatusUri = :uri", { uri })
            .andWhere(this.notExpired(now));
        const { after } = page;
        if (after) {
            query.andWhere(
                new Brackets((q) => {
                    q.where("record.statusListId > :afterList", {
                        afterList: after.statusListId,
                    }).orWhere(
                        new Brackets((same) => {
                            same.where("record.statusListId = :afterList", {
                                afterList: after.statusListId,
                            }).andWhere("record.index > :afterIndex", {
                                afterIndex: after.index,
                            });
                        }),
                    );
                }),
            );
        }
        const records = await query
            .orderBy("record.statusListId", "ASC")
            .addOrderBy("record.index", "ASC")
            .take(page.limit)
            .getMany();
        return records.map((record) => ({
            tenantId: record.tenantId,
            statusListId: record.statusListId,
            index: record.index,
            sessionId: record.sessionId,
            credentialConfigurationId: record.credentialConfigurationId,
            walletUnit: {
                statusUri: record.walletUnitStatusUri,
                statusIdx: record.walletUnitStatusIdx,
                certificates: record.walletUnitCertificates,
            },
        }));
    }

    async delete(
        tenantId: string,
        entries: readonly CredentialStatusEntry[],
    ): Promise<void> {
        for (let i = 0; i < entries.length; i += DELETE_CHUNK_SIZE) {
            const chunk = entries.slice(i, i + DELETE_CHUNK_SIZE);
            await this.repository.delete(
                chunk.map((entry) => ({
                    tenantId,
                    statusListId: entry.statusListId,
                    index: entry.index,
                })),
            );
        }
    }

    private notExpired(now: Date): Brackets {
        return new Brackets((query) => {
            query
                .where("record.credentialExpiresAt IS NULL")
                .orWhere("record.credentialExpiresAt > :now", {
                    now: now.getTime(),
                });
        });
    }
}
