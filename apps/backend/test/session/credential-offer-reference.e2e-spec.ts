import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Use the production module graph with an isolated database. Never load or
// delete the developer's configured database or import their configuration.
describe.each([false, true])(
    "credential-offer HTTP contract (multiple consumption: %s)",
    (multiple) => {
        let app: INestApplication;
        let folder: string;
        let db: DataSource;
        let seed: (hasOffer?: boolean) => Promise<string>;
        const offer = {
            credential_issuer: "https://issuer.example/tenant-a",
            credential_configuration_ids: ["pid"],
        };

        beforeAll(async () => {
            folder = mkdtempSync(join(tmpdir(), "eudiplo-offer-contract-"));
            vi.stubEnv("DB_TYPE", "sqlite");
            vi.stubEnv("FOLDER", folder);
            vi.stubEnv("CONFIG_IMPORT_MODE", "disabled");
            vi.stubEnv("ISSUER_MULTI_CONSUMPTION", String(multiple));
            vi.resetModules();
            const { AppModule } = await import("../../src/app.module.js");
            const { Session } = await import(
                "../../src/session/entities/session.entity.js"
            );
            const { TenantEntity } = await import(
                "../../src/auth/tenant/entities/tenant.entity.js"
            );
            const module = await Test.createTestingModule({
                imports: [AppModule],
            }).compile();
            app = module.createNestApplication();
            await app.init();
            // Keep one server open while concurrent requests run; Supertest
            // otherwise starts/stops its implicit listener per request.
            await app.listen(0, "127.0.0.1");
            db = app.get(DataSource);
            await db.getRepository(TenantEntity).save({ id: "tenant-a" });
            seed = async (hasOffer = true) => {
                const id = randomUUID();
                await db.getRepository(Session).save({
                    id,
                    tenantId: "tenant-a",
                    offer: hasOffer ? offer : null,
                });
                return id;
            };
        }, 60_000);

        afterAll(async () => {
            await app?.close();
            if (folder) rmSync(folder, { recursive: true, force: true });
            vi.unstubAllEnvs();
        });

        it("preserves the public route, payload, and repeated-consumption status", async () => {
            const id = await seed();
            const path = `/issuers/tenant-a/vci/credential-offers/${id}`;
            const first = await request(app.getHttpServer())
                .get(path)
                .expect(200);
            expect(first.body).toEqual(offer);
            const second = await request(app.getHttpServer())
                .get(path)
                .expect(multiple ? 200 : 404);
            expect(second.body).toEqual(
                multiple
                    ? offer
                    : {
                          statusCode: 404,
                          message: "Credential offer not found",
                          error: "Not Found",
                      },
            );
        });

        it("returns the same 404 for another tenant and an unknown session", async () => {
            const id = await seed();
            for (const path of [
                `/issuers/tenant-b/vci/credential-offers/${id}`,
                `/issuers/tenant-a/vci/credential-offers/${randomUUID()}`,
            ]) {
                const response = await request(app.getHttpServer())
                    .get(path)
                    .expect(404);
                expect(response.body).toEqual({
                    statusCode: 404,
                    message: "Credential offer not found",
                    error: "Not Found",
                });
            }
        });

        it("preserves the empty-offer response in both modes", async () => {
            const id = await seed(false);
            const response = await request(app.getHttpServer())
                .get(`/issuers/tenant-a/vci/credential-offers/${id}`)
                .expect(multiple ? 200 : 404);
            if (multiple) expect(response.text).toBe("");
            else
                expect(response.body.message).toBe(
                    "Credential offer not found",
                );
        });

        it("preserves concurrent HTTP consumption behavior", async () => {
            const id = await seed();
            const responses = await Promise.all(
                Array.from({ length: 4 }, () =>
                    request(app.getHttpServer()).get(
                        `/issuers/tenant-a/vci/credential-offers/${id}`,
                    ),
                ),
            );
            expect(
                responses.filter((response) => response.status === 200),
            ).toHaveLength(multiple ? 4 : 1);
            expect(
                responses.filter((response) => response.status === 404),
            ).toHaveLength(multiple ? 0 : 3);
        });
    },
);
