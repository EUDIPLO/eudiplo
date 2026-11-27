import "reflect-metadata";
import { createHash } from "node:crypto";
import { schemaUrl } from "@eudiplo/config-format/config-format.js";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import request from "supertest";
import type { App } from "supertest/types";
import type { Repository } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { Role } from "../../src/auth/roles/role.enum.js";
import { KeyUsageType } from "../../src/crypto/key/types/key-usage-type.js";
import type {
    ConfigBundle,
    ConfigImportPlan,
} from "../../src/platform/config-portability/config-resource.types.js";
import { createAppValidationPipe } from "../../src/shared/common/zod/zod-schema.util.js";
import { PresentationConfig } from "../../src/verifier/presentations/entities/presentation-config.entity.js";
import { getTenantAdminToken } from "../utils.js";
import { createKeyChain } from "../utils-ec.js";

/** Unique per run: the E2E database outlives a run. */
const tenant = `imported-registration-certificate-${Date.now().toString(36)}`;

/** Unsigned JWT; EUDIPLO only decodes registration certificates. */
function unsignedJwt(payload: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none", typ: "rc-rp+jwt" })}.${encode(payload)}.`;
}

/** A presentation config requesting given_name and family_name of a PID. */
function presentationDocument(id: string, registrationCertJwt?: string) {
    return {
        $schema: schemaUrl("PresentationConfig"),
        metadata: { generation: 1 },
        spec: {
            id,
            description: `Presentation config ${id}`,
            dcql_query: {
                credentials: [
                    {
                        id: "pid",
                        format: "dc+sd-jwt",
                        meta: { vct_values: ["<TENANT_URL>/credentials/pid"] },
                        claims: [
                            { path: ["given_name"] },
                            { path: ["family_name"] },
                        ],
                        trusted_authorities: [
                            {
                                type: "etsi_tl",
                                values: [{ url: "https://tl.example/pid" }],
                            },
                        ],
                    },
                ],
            },
            ...(registrationCertJwt
                ? { registration_cert: { jwt: registrationCertJwt } }
                : {}),
        },
    };
}

function bundleOf(
    documents: ReturnType<typeof presentationDocument>[],
): ConfigBundle {
    return {
        manifest: {
            format: "eudiplo.config-bundle",
            formatVersion: 2,
            sourceVersion: tenant,
            exportedAt: new Date(0).toISOString(),
            tenant,
            resources: documents.map((document) => ({
                kind: "PresentationConfig",
                id: document.spec.id,
                $schema: document.$schema,
                path: `presentation/${document.spec.id}.json`,
                sha256: createHash("sha256")
                    .update(JSON.stringify(document))
                    .digest("hex"),
                ownership: "unmanaged",
                generation: 1,
            })),
            assets: [],
            requirements: [],
            warnings: [],
        },
        documents,
        assets: [],
    } as ConfigBundle;
}

/**
 * The plan checks an imported `registration_cert.jwt` the way saving a
 * presentation config does, so apply refuses the bundle before any
 * operation runs instead of stopping halfway.
 */
describe("config bundle plan with an imported registration certificate (e2e)", () => {
    let app: INestApplication<App>;
    let auth: string;
    let vct: string;

    const api = () => request(app.getHttpServer());

    const certificate = (
        claims: string[][],
        exp = Math.floor(Date.now() / 1000) + 3600,
        extra: object = {},
    ) =>
        unsignedJwt({
            ...extra,
            iat: Math.floor(Date.now() / 1000),
            exp,
            credentials: [
                {
                    format: "dc+sd-jwt",
                    meta: { vct_values: [vct] },
                    claim: claims.map((path) => ({ path })),
                },
            ],
        });

    async function plan(bundle: ConfigBundle): Promise<ConfigImportPlan> {
        return (
            await api()
                .post("/config-bundles/plan?mode=upsert")
                .set("Authorization", auth)
                .send(bundle)
                .expect(201)
        ).body;
    }

    async function storedIds(): Promise<string[]> {
        const response = await api()
            .get("/verifier/config")
            .set("Authorization", auth)
            .expect(200);
        return response.body.map((config: { id: string }) => config.id);
    }

    function apply(bundle: ConfigBundle, planFingerprint: string) {
        return api()
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(bundle);
    }

    /** A certificate that covers the presentation document's query. */
    const covering = () => certificate([["family_name"], ["given_name"]]);
    const expiredCovering = () =>
        certificate(
            [["family_name"], ["given_name"]],
            Math.floor(Date.now() / 1000) - 3600,
        );

    /** Apply a presentation config with a covering certificate. */
    async function storeCovered(id: string) {
        const bundle = bundleOf([presentationDocument(id, covering())]);
        const result = await plan(bundle);
        await apply(bundle, result.planFingerprint!).expect(201);
    }

    async function expectRefused(jwt: string, message: string) {
        const bundle = bundleOf([
            // Valid and listed first: apply would store it before reaching
            // the refused certificate if the plan did not block.
            presentationDocument("first"),
            presentationDocument("refused", jwt),
        ]);

        const result = await plan(bundle);

        expect(result.applicable).toBe(false);
        const item = result.items.find(
            (candidate) => candidate.id === "refused",
        );
        expect(item?.action).toBe("blocked");
        expect(item?.issues).toEqual([
            {
                severity: "error",
                code: "REGISTRATION_CERTIFICATE_REFUSED",
                path: "/spec/registration_cert",
                message,
                resource: { kind: "PresentationConfig", id: "refused" },
            },
        ]);

        const applied = await api()
            .post(
                `/config-bundles/import?mode=upsert&planFingerprint=${result.planFingerprint}`,
            )
            .set("Authorization", auth)
            .send(bundle)
            .expect(400);
        expect(applied.body.code).toBe("CONFIG_APPLY_BLOCKED");
        // No operation ran: not even the valid config listed first is stored.
        const stored = await storedIds();
        expect(stored).not.toContain("first");
        expect(stored).not.toContain("refused");
    }

    beforeAll(async () => {
        const moduleFixture = await Test.createTestingModule({
            imports: [AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(createAppValidationPipe());
        await app.init();

        const config = app.get(ConfigService);
        auth = `Bearer ${await getTenantAdminToken(
            app,
            config.getOrThrow<string>("AUTH_CLIENT_ID"),
            config.getOrThrow<string>("AUTH_CLIENT_SECRET"),
            tenant,
            [Role.Presentations, Role.Keys],
        )}`;
        // An access key chain whose generated certificate carries no
        // organizationIdentifier, for the access certificate match.
        await createKeyChain(app, auth.slice("Bearer ".length), {
            usageType: KeyUsageType.Access,
        });
        vct = `${config.getOrThrow<string>("PUBLIC_URL")}/issuers/${tenant}/credentials/pid`;
    });

    afterAll(async () => {
        await app?.close();
    });

    test("exports an imported certificate and re-imports it unchanged", async () => {
        await storeCovered("exported");
        const jwt = covering();
        const bundle = bundleOf([presentationDocument("exported", jwt)]);
        await apply(bundle, (await plan(bundle)).planFingerprint!).expect(201);

        const document = (
            await api()
                .get(
                    "/config-bundles/resources/PresentationConfig/exported/document",
                )
                .set("Authorization", auth)
                .expect(200)
        ).body;
        expect(document.spec.registration_cert).toEqual({ jwt });
        const result = await plan(bundleOf([document]));
        expect(result.items.map((item) => item.action)).toEqual(["unchanged"]);

        // A bundle export keeps the certificate as well.
        const exported: ConfigBundle = (
            await api()
                .get("/config-bundles/export")
                .set("Authorization", auth)
                .expect(200)
        ).body;
        const presentation = exported.documents.find(
            (candidate) => candidate.spec.id === "exported",
        );
        expect(presentation?.spec.registration_cert).toEqual({ jwt });
        const replanned = await plan(exported);
        expect(
            replanned.items
                .filter((item) => item.id === "exported")
                .map((item) => item.action),
        ).toEqual(["unchanged"]);
    });

    test("blocks a certificate that does not cover the request", async () => {
        await expectRefused(
            certificate([["given_name"]]),
            "Registration certificate does not authorize the requested DCQL credentials",
        );
    });

    test("blocks a certificate issued to another relying party than the stored access certificate's", async () => {
        // The tenant's generated access certificate has no organizationIdentifier.
        await expectRefused(
            certificate(
                [["given_name"], ["family_name"]],
                Math.floor(Date.now() / 1000) + 3600,
                { sub: { id: "VATDE-999999999" } },
            ),
            "The registration certificate does not belong to the access certificate: its sub.id is 'VATDE-999999999', but the access certificate subject has no organizationIdentifier or serialNumber",
        );
    });

    test("blocks an expired certificate", async () => {
        await expectRefused(
            certificate(
                [["given_name"], ["family_name"]],
                Math.floor(Date.now() / 1000) - 3600,
            ),
            "Registration certificate is expired",
        );
    });

    test("blocks a value that is not a JWT", async () => {
        await expectRefused(
            "not-a-jwt",
            "Registration certificate is not a valid JWT",
        );
    });

    test("accepts and applies a certificate that covers the request with <TENANT_URL> resolved for the target tenant", async () => {
        const bundle = bundleOf([presentationDocument("covered", covering())]);
        const result = await plan(bundle);

        expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
        // Save checks the certificate again, so plan and save agree.
        await apply(bundle, result.planFingerprint!).expect(201);
        expect(await storedIds()).toContain("covered");
    });

    test("blocks an update to a certificate that fails its checks", async () => {
        await storeCovered("updated");

        const result = await plan(
            bundleOf([presentationDocument("updated", expiredCovering())]),
        );

        expect(result.applicable).toBe(false);
        expect(result.items[0]).toMatchObject({
            id: "updated",
            action: "blocked",
            issues: [
                expect.objectContaining({
                    code: "REGISTRATION_CERTIFICATE_REFUSED",
                    message: "Registration certificate is expired",
                }),
            ],
        });
    });

    test("does not block an unchanged document whose certificate expired since it was applied", async () => {
        await storeCovered("unchanged");
        const expired = expiredCovering();
        // The certificate expired after the config was stored.
        const repository = app.get<Repository<PresentationConfig>>(
            getRepositoryToken(PresentationConfig),
        );
        await repository.update(
            { tenantId: tenant, id: "unchanged" },
            { registration_cert: { jwt: expired } },
        );

        const result = await plan(
            bundleOf([presentationDocument("unchanged", expired)]),
        );

        expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
        expect(result.items[0]).toMatchObject({
            id: "unchanged",
            action: "unchanged",
            issues: [],
        });
    });

    test("does not block a skipped document with an expired certificate", async () => {
        await storeCovered("detached");
        await api()
            .post(
                "/config-bundles/resources/PresentationConfig/detached/detach",
            )
            .set("Authorization", auth)
            .expect(201);

        const result = await plan(
            bundleOf([presentationDocument("detached", expiredCovering())]),
        );

        expect(result.applicable, JSON.stringify(result.issues)).toBe(true);
        expect(result.items[0]).toMatchObject({
            id: "detached",
            action: "skip",
        });
        expect(result.issues.map((issue) => issue.code)).not.toContain(
            "REGISTRATION_CERTIFICATE_REFUSED",
        );
    });
});
