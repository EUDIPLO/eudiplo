import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import { Agent, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CredentialConfigUpdate } from "../../src/issuer/configuration/credentials/dto/credential-config-update.dto.js";
import { CredentialFormat } from "../../src/issuer/configuration/credentials/entities/credential.entity.js";
import { IssuanceTestContext, setupIssuanceTestApp } from "../utils.js";

setGlobalDispatcher(
    new Agent({
        connect: {
            rejectUnauthorized: false,
        },
    }),
);

describe("Issuance - Claims Metadata", () => {
    let app: INestApplication<App>;
    let authToken: string;
    let ctx: IssuanceTestContext;

    beforeAll(async () => {
        ctx = await setupIssuanceTestApp();
        app = ctx.app;
        authToken = ctx.authToken;
    });

    afterAll(async () => {
        if (app) {
            await app?.close();
        }
    });

    test("create credential config with claims metadata", async () => {
        const credentialConfig: CredentialConfigUpdate = {
            id: "test-claims-metadata",
            description: "Test credential with claims metadata",
            config: {
                format: CredentialFormat.SD_JWT_VC,
                display: [
                    {
                        name: "Test Credential",
                        description: "A test credential with claims metadata",
                        locale: "en-US",
                    },
                ],
            },
            vct: "urn:test:claims-metadata:1",
            fields: [
                {
                    path: ["given_name"],
                    type: "string",
                    defaultValue: "Test",
                    mandatory: false,
                    disclosable: true,
                    display: [
                        { name: "Given Name", locale: "en-US" },
                        { name: "Vorname", locale: "de-DE" },
                    ],
                },
                {
                    path: ["family_name"],
                    type: "string",
                    defaultValue: "User",
                    mandatory: true,
                    disclosable: true,
                    display: [
                        { name: "Family Name", locale: "en-US" },
                        { name: "Nachname", locale: "de-DE" },
                    ],
                },
                {
                    path: ["address", "street_address"],
                    type: "string",
                    defaultValue: "123 Test St",
                    disclosable: true,
                    display: [{ name: "Street Address", locale: "en-US" }],
                },
            ],
        };

        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(credentialConfig)
            .expect(201);
    });

    test("issuer metadata contains claims metadata", async () => {
        const tenantId = "root";

        const res = await request(app.getHttpServer())
            .get(`/.well-known/openid-credential-issuer/issuers/${tenantId}`)
            .trustLocalhost()
            .set("Accept", "application/json")
            .expect(200);

        expect(res.body).toBeDefined();
        expect(res.body.credential_configurations_supported).toBeDefined();

        // Check the test-claims-metadata credential config
        const credConfig =
            res.body.credential_configurations_supported[
                "test-claims-metadata"
            ];
        console.log(credConfig);
        expect(credConfig).toBeDefined();
        expect(credConfig.format).toBe("dc+sd-jwt");

        // Verify credential_metadata structure
        expect(credConfig.credential_metadata).toBeDefined();
        expect(credConfig.credential_metadata.display).toBeDefined();
        expect(credConfig.credential_metadata.claims).toBeDefined();

        // Verify claims array
        const claims = credConfig.credential_metadata.claims;
        expect(claims).toHaveLength(3);

        // Check given_name claim
        const givenNameClaim = claims.find(
            (c: any) =>
                JSON.stringify(c.path) === JSON.stringify(["given_name"]),
        );

        expect(givenNameClaim).toBeDefined();
        expect(givenNameClaim.mandatory).toBe(false);
        expect(givenNameClaim.display).toHaveLength(2);
        expect(givenNameClaim.display[0].name).toBe("Given Name");
        expect(givenNameClaim.display[0].locale).toBe("en-US");
        expect(givenNameClaim.display[1].name).toBe("Vorname");
        expect(givenNameClaim.display[1].locale).toBe("de-DE");

        // Check family_name claim (mandatory)
        const familyNameClaim = claims.find(
            (c: any) =>
                JSON.stringify(c.path) === JSON.stringify(["family_name"]),
        );
        expect(familyNameClaim).toBeDefined();
        expect(familyNameClaim.mandatory).toBe(true);

        // Check nested path claim
        const addressClaim = claims.find(
            (c: any) =>
                JSON.stringify(c.path) ===
                JSON.stringify(["address", "street_address"]),
        );
        expect(addressClaim).toBeDefined();
        expect(addressClaim.display[0].name).toBe("Street Address");
    });

    test("create mDOC credential config with claims metadata", async () => {
        const credentialConfig: CredentialConfigUpdate = {
            id: "test-mdoc-claims-metadata",
            description: "Test mDOC credential with claims metadata",
            config: {
                format: CredentialFormat.MSO_MDOC,
                docType: "org.test.claims.1",
                display: [
                    {
                        name: "Test mDOC Credential",
                        description:
                            "A test mDOC credential with claims metadata",
                        locale: "en-US",
                    },
                ],
            },
            fields: [
                {
                    path: ["given_name"],
                    type: "string",
                    defaultValue: "Test",
                    namespace: "org.test.claims",
                    display: [{ name: "Given Name", locale: "en-US" }],
                },
                {
                    path: ["family_name"],
                    type: "string",
                    defaultValue: "User",
                    mandatory: true,
                    namespace: "org.test.claims",
                    display: [{ name: "Family Name", locale: "en-US" }],
                },
            ],
        };

        await request(app.getHttpServer())
            .post("/issuer/credentials")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(credentialConfig)
            .expect(201);

        // Verify metadata
        const tenantId = "root";
        const res = await request(app.getHttpServer())
            .get(`/.well-known/openid-credential-issuer/issuers/${tenantId}`)
            .trustLocalhost()
            .set("Accept", "application/json")
            .expect(200);

        const credConfig =
            res.body.credential_configurations_supported[
                "test-mdoc-claims-metadata"
            ];
        expect(credConfig).toBeDefined();
        expect(credConfig.format).toBe("mso_mdoc");
        expect(credConfig.credential_metadata).toBeDefined();
        expect(credConfig.credential_metadata.claims).toBeDefined();
        expect(credConfig.credential_metadata.claims).toHaveLength(2);

        // Check mDOC claim path structure [namespace, claim_name]
        const givenNameClaim = credConfig.credential_metadata.claims.find(
            (c: any) =>
                JSON.stringify(c.path) ===
                JSON.stringify(["org.test.claims", "given_name"]),
        );
        expect(givenNameClaim).toBeDefined();
    });

    test("update credential config claims metadata", async () => {
        // First update the credential config with new claims
        const updatePayload: CredentialConfigUpdate = {
            config: {
                format: CredentialFormat.SD_JWT_VC,
                display: [
                    {
                        name: "Updated Test Credential",
                        description: "Updated description",
                        locale: "en-US",
                    },
                ],
            },
            fields: [
                {
                    path: ["given_name"],
                    type: "string",
                    defaultValue: "Test",
                    mandatory: true,
                    disclosable: true,
                    display: [{ name: "First Name", locale: "en-US" }],
                },
            ],
        };

        await request(app.getHttpServer())
            .patch("/issuer/credentials/test-claims-metadata")
            .trustLocalhost()
            .set("Authorization", `Bearer ${authToken}`)
            .send(updatePayload)
            .expect(200);

        // Verify the update in metadata
        const tenantId = "root";
        const res = await request(app.getHttpServer())
            .get(`/.well-known/openid-credential-issuer/issuers/${tenantId}`)
            .trustLocalhost()
            .set("Accept", "application/json")
            .expect(200);

        const credConfig =
            res.body.credential_configurations_supported[
                "test-claims-metadata"
            ];
        expect(credConfig).toBeDefined();
        expect(credConfig.credential_metadata.claims).toHaveLength(1);

        const givenNameClaim = credConfig.credential_metadata.claims[0];
        expect(givenNameClaim.mandatory).toBe(true);
        expect(givenNameClaim.display[0].name).toBe("First Name");
    });
});
