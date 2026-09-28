import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ClientEntity } from "../../auth/client/entities/client.entity.js";
import { TenantEntity } from "../../auth/tenant/entities/tenant.entity.js";
import type { CredentialConfig } from "../configuration/credentials/entities/credential.entity.js";
import { ActiveCredentialSlot } from "./entities/active-credential-slot.entity.js";
import { StatusListEntity } from "./entities/status-list.entity.js";
import { StatusMapping } from "./entities/status-mapping.entity.js";
import { StatusListService } from "./status-list.service.js";
import type { SubjectKeyService } from "./subject-key.service.js";

/**
 * Tests for the active-credential-limit policy (issue #843).
 *
 * These run against a real SQLite DataSource rather than mocked repositories,
 * because the concurrency guarantee rests on an actual database unique
 * constraint — mocks would not exercise the mechanism under test.
 */

const TENANT = "tenant-1";
const CONFIG_ID = "pid";
const STATUS_VALID = 0;
const STATUS_REVOKED = 1;
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";

function makeSession(overrides: Record<string, unknown> = {}) {
    return {
        id: `session-${randomUUID()}`,
        tenantId: TENANT,
        externalIssuer: "https://as.example.com",
        externalSubject: "user-123",
        ...overrides,
    } as never;
}

function makeConfig(overrides: Record<string, unknown> = {}): CredentialConfig {
    return {
        id: CONFIG_ID,
        statusManagement: true,
        activeCredentials: { enabled: true, tracking: "internal" },
        ...overrides,
    } as CredentialConfig;
}

describe("StatusListService active-credential limit", () => {
    let dataSource: DataSource;
    let service: StatusListService;

    beforeEach(async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [
                ClientEntity,
                TenantEntity,
                StatusListEntity,
                StatusMapping,
                ActiveCredentialSlot,
            ],
            synchronize: true,
        });
        await dataSource.initialize();

        // Deterministic subject key: same iss+sub always yields the same value,
        // different sub yields a different one.
        const subjectKeyService = {
            deriveSubjectKey: vi.fn(
                async (p: {
                    tenantId: string;
                    credentialConfigurationId: string;
                    iss: string;
                    sub: string;
                }) =>
                    `sk:${p.tenantId}:${p.credentialConfigurationId}:${p.iss}:${p.sub}`,
            ),
        } as unknown as SubjectKeyService;

        service = new StatusListService(
            {
                publicUrl: "https://issuer.example",
                statusCapacity: 4,
                statusBits: 1,
            },
            {} as never,
            {} as never,
            dataSource,
            dataSource.getRepository(StatusMapping),
            dataSource.getRepository(StatusListEntity),
            dataSource.getRepository(TenantEntity),
            {} as never,
            { getEffectiveConfig: vi.fn(async () => ({})) } as never,
            { register: vi.fn() } as never,
            dataSource.getRepository(ActiveCredentialSlot),
            subjectKeyService,
        );

        await dataSource.getRepository(TenantEntity).save({
            id: TENANT,
            name: "Tenant 1",
            status: "active",
        });
        await dataSource.getRepository(StatusListEntity).save({
            id: "list-1",
            tenantId: TENANT,
            credentialConfigurationId: null,
            bits: 1,
            stack: Array.from({ length: 32 }, (_, i) => i),
            elements: Array.from({ length: 32 }, () => STATUS_VALID),
        });
    });

    async function statusAt(index: number): Promise<number> {
        const list = await dataSource
            .getRepository(StatusListEntity)
            .findOneByOrFail({ id: "list-1", tenantId: TENANT });
        return list.elements[index];
    }

    test("first issuance creates a slot and revokes nothing", async () => {
        const result = await service.createEntry(
            makeSession(),
            CONFIG_ID,
            makeConfig(),
            TOKEN_A,
        );

        const slots = await dataSource
            .getRepository(ActiveCredentialSlot)
            .find();
        expect(slots).toHaveLength(1);
        expect(slots[0].issuanceSetId).toBeTruthy();

        // The freshly issued entry is still valid.
        expect(await statusAt(result.status.status_list.idx)).toBe(
            STATUS_VALID,
        );
    });

    test("re-issuance to the same subject revokes the previous entry only", async () => {
        const first = await service.createEntry(
            makeSession(),
            CONFIG_ID,
            makeConfig(),
            TOKEN_A,
        );
        const second = await service.createEntry(
            makeSession(),
            CONFIG_ID,
            makeConfig(),
            TOKEN_B,
        );

        expect(await statusAt(first.status.status_list.idx)).toBe(
            STATUS_REVOKED,
        );
        expect(await statusAt(second.status.status_list.idx)).toBe(
            STATUS_VALID,
        );

        // Still exactly one slot for the subject.
        expect(
            await dataSource.getRepository(ActiveCredentialSlot).count(),
        ).toBe(1);
    });

    test("repeated credential endpoint calls with one token keep the batch active", async () => {
        const session = makeSession({ id: "session-batch" });
        const first = await service.createEntry(
            session,
            CONFIG_ID,
            makeConfig(),
            TOKEN_A,
        );
        const second = await service.createEntry(
            session,
            CONFIG_ID,
            makeConfig(),
            TOKEN_A,
        );

        expect(await statusAt(first.status.status_list.idx)).toBe(STATUS_VALID);
        expect(await statusAt(second.status.status_list.idx)).toBe(
            STATUS_VALID,
        );
        expect(
            await dataSource
                .getRepository(ActiveCredentialSlot)
                .findOneByOrFail({
                    tenantId: TENANT,
                    credentialConfigurationId: CONFIG_ID,
                    subjectScopedKey: `sk:${TENANT}:${CONFIG_ID}:https://as.example.com:user-123`,
                }),
        ).toMatchObject({ issuanceSetId: TOKEN_A });
    });

    test("a different subject is unaffected", async () => {
        const userA = await service.createEntry(
            makeSession({ externalSubject: "user-A" }),
            CONFIG_ID,
            makeConfig(),
            TOKEN_A,
        );
        const userB = await service.createEntry(
            makeSession({ externalSubject: "user-B" }),
            CONFIG_ID,
            makeConfig(),
            TOKEN_A,
        );

        expect(await statusAt(userA.status.status_list.idx)).toBe(STATUS_VALID);
        expect(await statusAt(userB.status.status_list.idx)).toBe(STATUS_VALID);
        expect(
            await dataSource.getRepository(ActiveCredentialSlot).count(),
        ).toBe(2);
    });

    test("concurrent slot claims for one subject converge on a single slot", async () => {
        // Exercises the slot mechanism directly rather than through
        // allocateEntries, because concurrent allocation on SQLite currently
        // fails independently of this policy (see PR notes) — the guarantee
        // under test here is that the unique constraint admits exactly one slot
        // per subject however the claims interleave.
        const claim = (issuanceSetId: string) =>
            (
                service as unknown as {
                    replaceActiveIssuance: (p: {
                        tenantId: string;
                        credentialConfigurationId: string;
                        subjectScopedKey: string;
                        issuanceSetId: string;
                    }) => Promise<void>;
                }
            ).replaceActiveIssuance({
                tenantId: TENANT,
                credentialConfigurationId: CONFIG_ID,
                subjectScopedKey: "sk:concurrent",
                issuanceSetId,
            });

        await Promise.all([claim("set-a"), claim("set-b"), claim("set-c")]);

        const slots = await dataSource
            .getRepository(ActiveCredentialSlot)
            .findBy({ subjectScopedKey: "sk:concurrent" });

        expect(slots).toHaveLength(1);
        expect(["set-a", "set-b", "set-c"]).toContain(slots[0].issuanceSetId);
    });

    test("policy is skipped when no durable subject identity is present", async () => {
        const session = makeSession({
            externalIssuer: null,
            externalSubject: null,
        });

        const result = await service.createEntry(
            session,
            CONFIG_ID,
            makeConfig(),
            TOKEN_A,
        );

        expect(
            await dataSource.getRepository(ActiveCredentialSlot).count(),
        ).toBe(0);
        expect(await statusAt(result.status.status_list.idx)).toBe(
            STATUS_VALID,
        );

        const mapping = await dataSource
            .getRepository(StatusMapping)
            .findOneByOrFail({
                tenantId: TENANT,
                index: result.status.status_list.idx,
            });
        expect(mapping.issuanceSetId).toBeNull();
    });

    test("policy is skipped when disabled or when statusManagement is off", async () => {
        await service.createEntry(
            makeSession(),
            CONFIG_ID,
            makeConfig({ activeCredentials: { enabled: false } }),
        );
        await service.createEntry(
            makeSession(),
            CONFIG_ID,
            makeConfig({ statusManagement: false }),
        );
        await service.createEntry(makeSession(), CONFIG_ID);

        expect(
            await dataSource.getRepository(ActiveCredentialSlot).count(),
        ).toBe(0);
    });

    test("an issuance that fails to allocate leaves the existing credential valid", async () => {
        const first = await service.createEntry(
            makeSession(),
            CONFIG_ID,
            makeConfig(),
            TOKEN_A,
        );

        // Exhaust the list so the next allocation cannot succeed.
        await dataSource
            .getRepository(StatusListEntity)
            .update({ id: "list-1", tenantId: TENANT }, { stack: [] });
        vi.spyOn(
            service as unknown as { createNewList: () => Promise<never> },
            "createNewList",
        ).mockRejectedValue(new Error("allocation unavailable"));

        await expect(
            service.createEntry(makeSession(), CONFIG_ID, makeConfig()),
        ).rejects.toThrow();

        // The previously issued credential must survive a failed replacement.
        expect(await statusAt(first.status.status_list.idx)).toBe(STATUS_VALID);
    });
});
