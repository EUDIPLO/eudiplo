import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Test, type TestingModule } from "@nestjs/testing";
import { cleanupOpenApiDoc } from "nestjs-zod";
import request from "supertest";
import { App } from "supertest/types";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GLOBAL_PREFIX_EXCLUSIONS } from "../src/main.helpers.js";

function getOperation(
    document: ReturnType<typeof cleanupOpenApiDoc>,
    path: string,
    method: keyof NonNullable<(typeof document.paths)[string]>,
) {
    const pathItem = document.paths[path];
    if (!pathItem) {
        throw new Error(`Missing path ${path}`);
    }

    const operation = pathItem[method];
    if (!operation) {
        throw new Error(
            `Missing ${method.toUpperCase()} operation for ${path}`,
        );
    }

    return operation;
}

describe("OpenAPI contract", () => {
    let app: INestApplication<App>;
    let document: ReturnType<typeof cleanupOpenApiDoc>;

    beforeAll(async () => {
        const moduleFixture: TestingModule = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();

        app = moduleFixture.createNestApplication();
        app.setGlobalPrefix("api", { exclude: GLOBAL_PREFIX_EXCLUSIONS });

        const swaggerDocument = SwaggerModule.createDocument(
            app,
            new DocumentBuilder()
                .setTitle("EUDIPLO")
                .setOpenAPIVersion("3.1.0")
                .setVersion("test")
                .build(),
        );

        document = cleanupOpenApiDoc(swaggerDocument);

        const managementDocFactory = () =>
            cleanupOpenApiDoc(
                SwaggerModule.createDocument(
                    app,
                    new DocumentBuilder()
                        .setTitle("EUDIPLO Management API")
                        .setOpenAPIVersion("3.1.0")
                        .setVersion("test")
                        .build(),
                ),
            );

        const protocolDocFactory = () =>
            cleanupOpenApiDoc(
                SwaggerModule.createDocument(
                    app,
                    new DocumentBuilder()
                        .setTitle("EUDIPLO Protocol API")
                        .setOpenAPIVersion("3.1.0")
                        .setVersion("test")
                        .build(),
                ),
            );

        SwaggerModule.setup("/api/docs", app, managementDocFactory);
        SwaggerModule.setup("/docs", app, protocolDocFactory);

        await app.init();
    });

    afterAll(async () => {
        await app?.close();
    });

    test.each([
        ["management Swagger UI", "/api/docs"],
        ["management Swagger init script", "/api/docs/swagger-ui-init.js"],
        ["protocol Swagger UI", "/docs"],
        ["protocol Swagger init script", "/docs/swagger-ui-init.js"],
    ])("serves %s", async (_label, path) => {
        await request(app.getHttpServer()).get(path).expect(200);
    });

    test("keeps the public ClientEntity schema name for SDK compatibility", () => {
        const schemas = document.components?.schemas ?? {};
        expect(schemas).toHaveProperty("ClientEntity");
        expect(schemas).not.toHaveProperty("ClientResponseDto");
        expect(
            Object.keys((schemas.ClientEntity as any).properties).sort(),
        ).toEqual([
            "allowedIssuanceConfigs",
            "allowedPresentationConfigs",
            "clientId",
            "description",
            "roles",
            "tenantId",
        ]);
    });

    test("documents tenant description clearing without create-only PATCH fields", () => {
        const createTenantSchema = document.components?.schemas
            ?.CreateTenantDto as any;
        const updateTenantSchema = document.components?.schemas
            ?.UpdateTenantDto as any;
        const tenantResponseSchema = document.components?.schemas
            ?.TenantResponseDto as any;

        expect(createTenantSchema.properties.description).not.toMatchObject({
            nullable: true,
        });
        expect(updateTenantSchema.properties.description.anyOf).toEqual(
            expect.arrayContaining([{ type: "null" }]),
        );
        expect(updateTenantSchema.properties.description.description).toContain(
            "set to null to remove it",
        );
        expect(updateTenantSchema.properties.name.default).toBeUndefined();
        expect(updateTenantSchema.properties.roles).toBeUndefined();
        expect(updateTenantSchema.properties.id).toBeUndefined();
        // OpenAPI 3.1 encodes nullability in the type array, not `nullable: true`.
        expect(tenantResponseSchema.properties.description.type).toEqual(
            expect.arrayContaining(["null"]),
        );
    });

    test("documents the roles the RolesGuard accepts as security", () => {
        // Requirement objects are alternatives; the scopes inside one are all required.
        // Two handlers of one controller: the second must not repeat the first's.
        for (const path of ["/api/session", "/api/session/stats"]) {
            expect(getOperation(document, path, "get").security).toEqual([
                { oauth2: ["issuance:offer"] },
                { oauth2: ["presentation:request"] },
                { oauth2: ["sessions:read"] },
            ]);
        }
        // A handler's roles replace the controller's instead of adding to them.
        // Only the narrowest roles are listed; roles that include them pass too.
        expect(
            getOperation(document, "/api/session/{id}/credential-status", "get")
                .security,
        ).toEqual([
            { oauth2: ["issuance:offer"] },
            { oauth2: ["credentials:status"] },
            { oauth2: ["sessions:read"] },
        ]);
        expect(
            getOperation(document, "/api/session/revoke", "post").security,
        ).toEqual([{ oauth2: ["credentials:status"] }]);
        expect(
            getOperation(document, "/api/session/{id}", "delete").security,
        ).toEqual([
            { oauth2: ["issuance:offer"] },
            { oauth2: ["presentation:request"] },
        ]);
        // match "all": one requirement object with every role.
        expect(
            getOperation(
                document,
                "/api/eudi-hub/registration-certificate/issuer",
                "post",
            ).security,
        ).toEqual([{ oauth2: ["registrar:manage", "issuance:manage"] }]);
        expect(
            getOperation(document, "/api/eudi-hub/organizations", "post")
                .security,
        ).toEqual([{ oauth2: ["registrar:manage"] }]);
    });

    test("marks the required schema metadata values as required", () => {
        const schema = document.components?.schemas?.SchemaMetaConfig as {
            required?: string[];
        };

        expect(schema.required?.sort()).toEqual([
            "attestationLoS",
            "bindingType",
            "version",
        ]);
    });

    test("requires only name and locale in a credential display entry", () => {
        const schema = document.components?.schemas?.Display as {
            required?: string[];
        };

        expect(schema.required?.sort()).toEqual(["locale", "name"]);
    });

    test("documents key JSON, form, binary, SSE, and no-content responses", () => {
        const versionOperation = getOperation(document, "/api/version", "get");
        expect(
            versionOperation.responses["200"].content?.["application/json"]
                .schema,
        ).toMatchObject({ $ref: "#/components/schemas/VersionResponseDto" });

        const callerOperation = getOperation(document, "/api/auth/me", "get");
        expect(
            callerOperation.responses["200"].content?.["application/json"]
                .schema,
        ).toMatchObject({ $ref: "#/components/schemas/CallerResponseDto" });
        expect(callerOperation.security).toEqual([{ oauth2: [] }]);

        const tokenOperation = getOperation(
            document,
            "/api/oauth2/token",
            "post",
        );
        expect(
            tokenOperation.requestBody?.content?.[
                "application/x-www-form-urlencoded"
            ],
        ).toBeTruthy();

        const chainedAsParOperation = getOperation(
            document,
            "/issuers/{tenantId}/authorization-servers/{authorizationServerId}/par",
            "post",
        );
        expect(
            chainedAsParOperation.requestBody?.content?.[
                "application/x-www-form-urlencoded"
            ].schema,
        ).toMatchObject({
            $ref: "#/components/schemas/ChainedAsParRequestDto",
        });
        expect(
            document.components?.schemas?.ChainedAsParRequestDto?.properties
                ?.authorization_details,
        ).toBeDefined();
        expect(
            chainedAsParOperation.responses["201"].content?.["application/json"]
                .schema,
        ).toMatchObject({
            $ref: "#/components/schemas/ChainedAsParResponseDto",
        });

        const verifierResolveOperation = getOperation(
            document,
            "/api/verifier/config/schema-metadata/resolve",
            "post",
        );
        expect(
            verifierResolveOperation.responses["200"].content?.[
                "application/json"
            ].schema,
        ).toMatchObject({
            $ref: "#/components/schemas/ResolvedSchemaMetadataResponseDto",
        });

        const issuerConfigOperation = getOperation(
            document,
            "/api/issuer/config",
            "post",
        );
        expect(
            issuerConfigOperation.responses["200"].content?.["application/json"]
                .schema,
        ).toMatchObject({ $ref: "#/components/schemas/IssuanceConfig" });

        const credentialConfigDeleteOperation = getOperation(
            document,
            "/api/issuer/credentials/{id}",
            "delete",
        );
        expect(
            credentialConfigDeleteOperation.responses["204"].content,
        ).toBeUndefined();

        const keyChainCreateOperation = getOperation(
            document,
            "/api/key-chain",
            "post",
        );
        expect(
            keyChainCreateOperation.responses["201"].content?.[
                "application/json"
            ].schema,
        ).toMatchObject({ $ref: "#/components/schemas/KeyChainIdResponseDto" });

        const keyChainDeleteOperation = getOperation(
            document,
            "/api/key-chain/{id}",
            "delete",
        );
        expect(
            keyChainDeleteOperation.responses["204"].content,
        ).toBeUndefined();

        const sessionDeleteOperation = getOperation(
            document,
            "/api/session/{id}",
            "delete",
        );
        expect(sessionDeleteOperation.responses["204"].content).toBeUndefined();

        const sessionRevokeOperation = getOperation(
            document,
            "/api/session/revoke",
            "post",
        );
        expect(sessionRevokeOperation.responses["204"].content).toBeUndefined();

        const sessionConfigDeleteOperation = getOperation(
            document,
            "/api/session-config",
            "delete",
        );
        expect(
            sessionConfigDeleteOperation.responses["204"].content,
        ).toBeUndefined();

        const trustListDeleteOperation = getOperation(
            document,
            "/api/trust-list/{id}",
            "delete",
        );
        expect(
            trustListDeleteOperation.responses["204"].content,
        ).toBeUndefined();

        const userDeleteOperation = getOperation(
            document,
            "/api/user/{id}",
            "delete",
        );
        expect(userDeleteOperation.responses["204"].content).toBeUndefined();

        const deferredFailOperation = getOperation(
            document,
            "/api/issuer/deferred/{transactionId}/fail",
            "post",
        );
        expect(deferredFailOperation.requestBody?.required).toBe(true);

        const uploadOperation = getOperation(document, "/api/storage", "post");
        expect(
            uploadOperation.responses["200"].content?.["application/json"]
                .schema,
        ).toMatchObject({
            $ref: "#/components/schemas/StoredObjectResponseDto",
        });

        const issuerOfferOperation = getOperation(
            document,
            "/api/issuer/offer",
            "post",
        );
        expect(
            issuerOfferOperation.responses["201"].content?.["application/json"]
                .schema,
        ).toMatchObject({ $ref: "#/components/schemas/OfferResponse" });
        expect(
            issuerOfferOperation.responses["201"].content?.["image/png"].schema,
        ).toMatchObject({ type: "string", format: "binary" });

        const verifierOfferOperation = getOperation(
            document,
            "/api/verifier/offer",
            "post",
        );
        expect(
            verifierOfferOperation.responses["201"].content?.[
                "application/json"
            ].schema,
        ).toEqual({
            oneOf: [
                { $ref: "#/components/schemas/OfferResponse" },
                { $ref: "#/components/schemas/Iso18013OfferResponse" },
            ],
        });
        expect(
            verifierOfferOperation.responses["201"].content?.["image/png"]
                .schema,
        ).toMatchObject({ type: "string", format: "binary" });

        const sseOperation = getOperation(
            document,
            "/api/session/{id}/events",
            "get",
        );
        expect(
            sseOperation.responses["200"].content?.["text/event-stream"],
        ).toBeTruthy();

        const cacheDeleteOperation = getOperation(
            document,
            "/api/cache",
            "delete",
        );
        expect(cacheDeleteOperation.responses["204"].content).toBeUndefined();

        const attributeProviderDeleteOperation = getOperation(
            document,
            "/api/issuer/attribute-providers/{id}",
            "delete",
        );
        expect(
            attributeProviderDeleteOperation.responses["204"].content,
        ).toBeUndefined();

        const oid4vpAuthorizeOperation = getOperation(
            document,
            "/issuers/{tenantId}/authorization-servers/{authorizationServerId}/authorize",
            "get",
        );
        expect(
            oid4vpAuthorizeOperation.responses["200"].content?.["text/html"],
        ).toBeTruthy();

        const sessionEventsOperation = getOperation(
            document,
            "/api/session/{id}/events",
            "get",
        );
        expect(
            sessionEventsOperation.responses["200"].content?.[
                "text/event-stream"
            ].schema?.example,
        ).toContain("event: message");
    });
});
