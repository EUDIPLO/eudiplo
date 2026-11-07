import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientEntity } from "../../auth/client/entities/client.entity.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import { TrustListSequenceNumberEntity } from "../entities/trust-list-sequence-number.entity.js";
import { TypeOrmAcceptedTrustListSequenceNumbers } from "./typeorm-accepted-trust-list-sequence-numbers.js";

describe("TypeOrmAcceptedTrustListSequenceNumbers", () => {
    const url = "https://trust.example/list";
    let dataSource: DataSource;
    let numbers: TypeOrmAcceptedTrustListSequenceNumbers;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [
                TenantEntity,
                ClientEntity,
                TrustListSequenceNumberEntity,
            ],
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.getRepository(TenantEntity).insert([
            { id: "t", name: "t" },
            { id: "u", name: "u" },
        ] as TenantEntity[]);
        numbers = new TypeOrmAcceptedTrustListSequenceNumbers(
            dataSource.getRepository(TrustListSequenceNumberEntity),
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    it("knows no number for a list it never recorded", async () => {
        await expect(numbers.highest("t", url)).resolves.toBeUndefined();
    });

    it("raises the number and never lowers it", async () => {
        await numbers.record("t", url, 3);
        await expect(numbers.highest("t", url)).resolves.toBe(3);
        await numbers.record("t", url, 5);
        await expect(numbers.highest("t", url)).resolves.toBe(5);
        // A lower number, for example from an instance that loaded the list
        // before another one recorded a newer list, keeps the higher one.
        await numbers.record("t", url, 4);
        await expect(numbers.highest("t", url)).resolves.toBe(5);
    });

    it("keeps numbers beyond 32 bits as numbers", async () => {
        await numbers.record("t", url, 2 ** 40);
        await expect(numbers.highest("t", url)).resolves.toBe(2 ** 40);
    });

    it("keeps numbers apart per tenant and URL", async () => {
        await numbers.record("t", url, 5);
        await numbers.record("t", `${url}/other`, 2);
        await numbers.record("u", url, 1);
        await expect(numbers.highest("u", url)).resolves.toBe(1);
        await expect(numbers.highest("t", `${url}/other`)).resolves.toBe(2);
    });

    it("forgets the numbers of one tenant only", async () => {
        await numbers.record("t", url, 5);
        await numbers.record("u", url, 7);
        await numbers.forgetTenant("t");
        await expect(numbers.highest("t", url)).resolves.toBeUndefined();
        await expect(numbers.highest("u", url)).resolves.toBe(7);
        // A list accepted after forgetting starts a new record.
        await numbers.record("t", url, 1);
        await expect(numbers.highest("t", url)).resolves.toBe(1);
    });
});
