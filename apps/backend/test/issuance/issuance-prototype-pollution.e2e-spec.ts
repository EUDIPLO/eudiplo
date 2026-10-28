import { INestApplication } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import request from "supertest";
import { App } from "supertest/types";
import { Repository } from "typeorm";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CredentialConfigUpdate } from "../../src/issuer/configuration/credentials/dto/credential-config-update.dto.js";
import {
    CredentialConfig,
    CredentialFormat,
} from "../../src/issuer/configuration/credentials/entities/credential.entity.js";
import { builtInShape, changedBuiltIns } from "../shared/built-ins.js";
import { setupIssuanceTestApp } from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

/**
 * Configurations already in the database may contain `__proto__`,
 * `constructor` or `prototype` path segments, even if the API refuses them on
 * save later. Serving metadata and validating claims for them must not change
 * the built-ins of the process that serves every tenant.
 */
describe("Issuance - stored fields with prototype keys", () => {
    const configId = "prototype-keys";
    let app: INestApplication<App>;
    let authToken: string;
    let shapeBefore: Map<string, unknown>;

    beforeAll(async () => {
        const ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;

        const credentialConfig: CredentialConfigUpdate = {
            id: configId,
            description: "Fields with prototype keys",
            config: {
                format: CredentialFormat.SD_JWT_VC,
                display: [{ name: "Prototype keys", locale: "en-US" }],
            },
            vct: "urn:test:prototype-keys:1",
            fields: [{ path: ["given_name"], type: "string" }],
        };
        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(credentialConfig)
            .expect(201);

        // Stored directly, like a configuration saved before any check on its fields
        await app
            .get<Repository<CredentialConfig>>(
                getRepositoryToken(CredentialConfig),
            )
            .update({ tenantId: "root", id: configId }, {
                fields: [
                    {
                        path: ["__proto__", "x"],
                        type: "string",
                        mandatory: true,
                        disclosable: true,
                    },
                    {
                        path: ["constructor", "prototype", "y"],
                        type: "string",
                        mandatory: true,
                        disclosable: true,
                    },
                    {
                        path: ["__proto__", "toString"],
                        type: "string",
                        mandatory: true,
                    },
                    {
                        path: ["hasOwnProperty", "z"],
                        type: "string",
                        mandatory: true,
                    },
                ],
            } as any);

        shapeBefore = builtInShape();
    });

    afterAll(async () => {
        await app?.close();
    });

    // buildClaimsMetadata only maps paths, so this pins that the metadata
    // keeps listing such claims rather than a pollution path of its own
    test("issuer metadata lists the claims without polluting built-ins", async () => {
        const res = await request(app.getHttpServer())
            .get("/.well-known/openid-credential-issuer/issuers/root")
            .trustLocalhost()
            .set("Accept", "application/json")
            .expect(200);

        const claims =
            res.body.credential_configurations_supported[configId]
                .credential_metadata.claims;
        expect(claims.map((claim: { path: string[] }) => claim.path)).toEqual([
            ["__proto__", "x"],
            ["constructor", "prototype", "y"],
            ["__proto__", "toString"],
            ["hasOwnProperty", "z"],
        ]);
        expect(changedBuiltIns(shapeBefore)).toEqual([]);
        expect(({} as Record<string, unknown>).required).toBeUndefined();
    });

    test("validating inline offer claims does not pollute built-ins", async () => {
        // The claims are checked against the schema derived from the stored fields
        const res = await request(app.getHttpServer())
            .post("/issuer/offer")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send({
                flow: "pre_authorized_code",
                response_type: "uri",
                credentialConfigurationIds: [configId],
                credentialClaims: {
                    [configId]: { type: "inline", claims: { given: "x" } },
                },
            });

        expect(res.status).toBe(409);
        expect(changedBuiltIns(shapeBefore)).toEqual([]);
        expect(({} as Record<string, unknown>).required).toBeUndefined();
        expect(({} as Record<string, unknown>).properties).toBeUndefined();
    });
});
