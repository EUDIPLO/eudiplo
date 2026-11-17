import { DataSource } from "typeorm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClientEntity } from "../../../auth/client/entities/client.entity.js";
import { TenantEntity } from "../../../auth/tenant/entities/tenant.entity.js";
import { type OidcSignIn, OidcSignInStatus } from "../domain/oidc-sign-in.js";
import { OidcClientEntity } from "../entities/oidc-client.entity.js";
import { OidcSignInEntity } from "../entities/oidc-sign-in.entity.js";
import { TypeOrmOidcClientRepository } from "./typeorm-oidc-client.repository.js";
import { TypeOrmOidcSignInRepository } from "./typeorm-oidc-sign-in.repository.js";

describe("TypeORM OIDC repositories (SQLite)", () => {
    let dataSource: DataSource;
    let clients: TypeOrmOidcClientRepository;
    let signIns: TypeOrmOidcSignInRepository;
    const now = new Date("2026-01-01T10:00:00Z");

    beforeEach(async () => {
        dataSource = new DataSource({
            type: "better-sqlite3",
            database: ":memory:",
            entities: [
                TenantEntity,
                ClientEntity,
                OidcClientEntity,
                OidcSignInEntity,
            ],
            synchronize: true,
        });
        await dataSource.initialize();
        for (const id of ["a", "b"]) {
            await dataSource.getRepository(TenantEntity).insert({ id });
        }
        clients = new TypeOrmOidcClientRepository(
            dataSource.getRepository(OidcClientEntity),
        );
        signIns = new TypeOrmOidcSignInRepository(
            dataSource.getRepository(OidcSignInEntity),
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    const signIn = (overrides: Partial<OidcSignIn> = {}): OidcSignIn => ({
        id: "s1",
        tenantId: "a",
        clientId: "c",
        redirectUri: "https://rp/cb",
        scope: "openid pid",
        presentationConfigId: "pid",
        codeChallenge: "x".repeat(43),
        requireSameDevice: false,
        status: OidcSignInStatus.Authorized,
        walletReturnedElsewhere: false,
        codeHash: "hash",
        expiresAt: new Date(now.getTime() + 60_000),
        ...overrides,
    });

    test("transition is a conditional write, scoped to the tenant", async () => {
        await signIns.insert(signIn());
        expect(
            await signIns.transition("b", "s1", OidcSignInStatus.Authorized, {
                status: OidcSignInStatus.Redeemed,
            }),
        ).toBe(false);
        expect(
            await signIns.transition("a", "s1", OidcSignInStatus.Authorized, {
                status: OidcSignInStatus.Redeemed,
            }),
        ).toBe(true);
        expect(
            await signIns.transition("a", "s1", OidcSignInStatus.Authorized, {
                status: OidcSignInStatus.Redeemed,
            }),
        ).toBe(false);
    });

    test("findAuthorizedByCode ignores other tenants and statuses", async () => {
        await signIns.insert(signIn());
        await signIns.insert(
            signIn({
                id: "s2",
                status: OidcSignInStatus.Pending,
                codeHash: "p",
            }),
        );
        expect((await signIns.findAuthorizedByCode("a", "hash"))?.id).toBe(
            "s1",
        );
        expect(await signIns.findAuthorizedByCode("b", "hash")).toBeNull();
        expect(await signIns.findAuthorizedByCode("a", "p")).toBeNull();
    });

    test("deleteExpired removes only expired sign-ins", async () => {
        await signIns.insert(signIn());
        await signIns.insert(
            signIn({ id: "old", expiresAt: new Date(now.getTime() - 1) }),
        );
        expect(await signIns.deleteExpired(now)).toBe(1);
        expect(await signIns.findForTenant("a", "s1")).not.toBeNull();
    });

    test("recording a secret's use never brings back a deleted secret", async () => {
        const client = await clients.save({
            id: "c",
            tenantId: "a",
            name: "Portal",
            redirectUris: ["https://rp/cb"],
            profile: "secure",
            scopes: [],
            secrets: [
                { id: "old", hash: "h1", createdAt: now },
                { id: "new", hash: "h2", createdAt: now },
            ],
        });
        // The secret is deleted between authentication and the write.
        await clients.save({
            ...client,
            secrets: client.secrets.filter((secret) => secret.id !== "old"),
        });
        await clients.recordSecretUse("a", "c", "old", now);
        await clients.recordSecretUse("a", "c", "new", now);

        const stored = await clients.findForTenant("a", "c");
        expect(stored?.secrets.map((secret) => secret.id)).toEqual(["new"]);
        expect(stored?.secrets[0].lastUsedAt).toEqual(now);
        expect(await clients.findForTenant("b", "c")).toBeNull();

        // Saving the client keeps the last use in the result.
        const saved = await clients.save({ ...stored!, name: "Renamed" });
        expect(saved.secrets[0].lastUsedAt).toEqual(now);
    });

    test("stores the subject options of a client and of a sign-in", async () => {
        const base = {
            id: "c",
            tenantId: "a",
            name: "Portal",
            redirectUris: ["https://rp/cb"],
            profile: "secure" as const,
            scopes: [],
            secrets: [],
        };
        const saved = await clients.save({
            ...base,
            subject: { credentialId: "pid", claim: "a.b" },
            claimsFrom: "pid",
        });
        expect(saved).toMatchObject({
            subject: { credentialId: "pid", claim: "a.b" },
            claimsFrom: "pid",
        });
        const cleared = await clients.save({
            ...saved,
            subject: null,
            claimsFrom: null,
        });
        expect(cleared.subject).toBeNull();
        expect(cleared.claimsFrom).toBeNull();

        await signIns.insert(signIn({ status: OidcSignInStatus.Pending }));
        await signIns.transition("a", "s1", OidcSignInStatus.Pending, {
            subject: "pairwise",
        });
        expect((await signIns.findForTenant("a", "s1"))?.subject).toBe(
            "pairwise",
        );
    });

    test("recording a use writes only the last-use column", async () => {
        const repository = dataSource.getRepository(OidcClientEntity);
        const updates: unknown[] = [];
        const update = repository.update.bind(repository);
        repository.update = (async (...args: Parameters<typeof update>) => {
            updates.push(args[1]);
            return update(...args);
        }) as typeof repository.update;
        await clients.save({
            id: "c",
            tenantId: "a",
            name: "Portal",
            redirectUris: ["https://rp/cb"],
            profile: "secure",
            scopes: [],
            secrets: [{ id: "s", hash: "h", createdAt: now }],
        });
        await clients.recordSecretUse("a", "c", "s", now);
        expect(updates).toEqual([{ secretLastUsed: { s: now.toISOString() } }]);
    });
});
