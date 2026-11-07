import "reflect-metadata";
import { join } from "node:path";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getRepositoryToken } from "@nestjs/typeorm";
import nock from "nock";
import request from "supertest";
import { App } from "supertest/types";
import type { Repository } from "typeorm";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { Role } from "../../src/auth/roles/role.enum.js";
import type { TrustListCreateDto } from "../../src/issuer/trust-list/dto/trust-list-create.dto.js";
import { TrustListService } from "../../src/issuer/trust-list/trustlist.service.js";
import { OutdatedTrustListsError } from "../../src/trust/domain/trust-list-freshness.js";
import { TrustListSequenceNumberEntity } from "../../src/trust/entities/trust-list-sequence-number.entity.js";
import { TrustStoreService } from "../../src/trust/trust-store.service.js";
import {
    createMockTrustListJwt,
    generateSelfSignedCertificate,
} from "../issuance/attestation-trust-helpers.js";
import {
    clientToken,
    getTenantAdminToken,
    readConfig,
    setupPresentationTestApp,
} from "../utils.js";

/**
 * A trust list numbered lower than one the tenant accepted before from the
 * same URL is discarded, also after the trust list cache is cleared, until
 * the tenant forgets its numbers.
 */
describe("Trust list sequence numbers", () => {
    let app: INestApplication<App>;
    let rootToken: string;
    let otherToken: string;
    let signer: Awaited<ReturnType<typeof generateSelfSignedCertificate>>;
    let provider: Awaited<ReturnType<typeof generateSelfSignedCertificate>>;
    const path = `/sequence-${crypto.randomUUID()}`;
    const url = `http://localhost:8787${path}`;

    beforeAll(async () => {
        const ctx = await setupPresentationTestApp();
        app = ctx.app;
        rootToken = ctx.authToken;
        otherToken = await getTenantAdminToken(
            app,
            ctx.clientId,
            ctx.clientSecret,
            "sequence-other",
            [Role.Presentations, Role.Clients],
        );
        signer = await generateSelfSignedCertificate();
        provider = await generateSelfSignedCertificate();
    });

    afterEach(() => {
        nock.cleanAll();
    });

    afterAll(async () => {
        await app?.close();
    });

    /** Serve the list numbered `sequenceNumber` at the URL, once. */
    async function serve(sequenceNumber: number) {
        nock("http://localhost:8787")
            .get(path)
            .reply(
                200,
                await createMockTrustListJwt(
                    signer,
                    provider.certificate,
                    undefined,
                    sequenceNumber,
                ),
                { "Content-Type": "application/jwt" },
            );
    }

    const load = (tenantId: string) =>
        app.get(TrustStoreService).getTrustStore({
            tenantId,
            lotes: [
                {
                    url,
                    verifierX509Der: signer.certificate.toString("base64"),
                },
            ],
        });

    const clearTrustListCache = (token: string) =>
        request(app.getHttpServer())
            .delete("/cache/trust-list")
            .trustLocalhost()
            .set("Authorization", `Bearer ${token}`)
            .expect(204);

    const forget = (token: string) =>
        request(app.getHttpServer())
            .delete("/cache/trust-list/sequence-numbers")
            .trustLocalhost()
            .set("Authorization", `Bearer ${token}`);

    test("discards an older list until the tenant forgets its numbers", async () => {
        await serve(2);
        await expect(load("root")).resolves.toMatchObject({ discarded: [] });

        // The same URL serves the list before it: discarded, also after the
        // trust list cache is cleared.
        await clearTrustListCache(rootToken);
        await serve(1);
        await expect(load("root")).rejects.toBeInstanceOf(
            OutdatedTrustListsError,
        );
        await clearTrustListCache(rootToken);
        await serve(1);
        await expect(load("root")).rejects.toMatchObject({
            discarded: [
                { list: url, sequence: { number: 1, highestAccepted: 2 } },
            ],
        });

        // Another tenant keeps its own numbers.
        await serve(1);
        await expect(load("sequence-other")).resolves.toMatchObject({
            discarded: [],
        });

        await forget(rootToken).expect(204);
        await serve(1);
        await expect(load("root")).resolves.toMatchObject({ discarded: [] });

        // The other tenant still remembers its own number.
        await clearTrustListCache(otherToken);
        await serve(2);
        await expect(load("sequence-other")).resolves.toMatchObject({
            discarded: [],
        });
        await clearTrustListCache(otherToken);
        await serve(1);
        await expect(load("sequence-other")).rejects.toBeInstanceOf(
            OutdatedTrustListsError,
        );
        // Forgetting as root left it alone.
        await forget(rootToken).expect(204);
        await serve(1);
        await expect(load("sequence-other")).rejects.toBeInstanceOf(
            OutdatedTrustListsError,
        );
    });

    // A managed list deleted and created again starts at 1; referenced by its
    // public URL, it is compared with its stored number, not remembered.
    test("accepts a managed list created again under its URL", async () => {
        const id = "sequence-managed";
        const body = {
            ...readConfig<TrustListCreateDto>(
                join(
                    import.meta.dirname,
                    "../fixtures/haip/trust-lists/pid-tl.json",
                ),
            ),
            id,
        };
        const api = (method: "post" | "put" | "delete", path: string) =>
            request(app.getHttpServer())
                [method](path)
                .trustLocalhost()
                .set("Authorization", `Bearer ${rootToken}`);
        await api("post", "/trust-list").send(body).expect(201);
        await api("put", `/trust-list/${id}`).send(body).expect(200);

        const publicUrl = app
            .get(ConfigService)
            .getOrThrow<string>("PUBLIC_URL");
        const listUrl = `${publicUrl.replace(/\/$/, "")}/issuers/root/trust-list/${id}`;
        const lists = app.get(TrustListService);
        const loadManaged = async () =>
            app.get(TrustStoreService).getTrustStore({
                tenantId: "root",
                lotes: [
                    {
                        url: listUrl,
                        verifierX509Der: await lists.getVerifierX509Der(
                            "root",
                            id,
                        ),
                    },
                ],
            });
        await expect(loadManaged()).resolves.toMatchObject({ discarded: [] });

        await api("delete", `/trust-list/${id}`).expect(204);
        await api("post", "/trust-list").send(body).expect(201);
        await expect(lists.findOne("root", id)).resolves.toMatchObject({
            sequenceNumber: 1,
        });
        await clearTrustListCache(rootToken);
        await expect(loadManaged()).resolves.toMatchObject({ discarded: [] });

        const rows = app.get<Repository<TrustListSequenceNumberEntity>>(
            getRepositoryToken(TrustListSequenceNumberEntity),
        );
        await expect(rows.countBy({ url: listUrl })).resolves.toBe(0);
    });

    test("needs a role that manages issuance or presentations", async () => {
        const token = await clientToken(
            app,
            otherToken,
            "sequence-offer-only",
            [Role.IssuanceOffer],
        );
        await forget(token).expect(403);
    });
});
