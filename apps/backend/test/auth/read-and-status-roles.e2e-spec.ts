import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { App } from "supertest/types";
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "vitest";
import { Role } from "../../src/auth/roles/role.enum.js";
import { StatusListService } from "../../src/issuer/status-list/status-list.service.js";
import { SessionStore } from "../../src/session/application/session-store.js";
import { ResponseType } from "../../src/verifier/oid4vp/dto/presentation-request.dto.js";
import { clientToken, setupIssuanceTestApp } from "../utils.js";

const STATUS_CONFIG = "read-and-status-roles";
const UNKNOWN_SESSION = "00000000-0000-0000-0000-000000000000";

/**
 * The read roles (`audit:read`, `sessions:read`), `credentials:status` and
 * `keys:manage` open exactly their endpoints, with tokens from the token
 * endpoint, and never widen what the other roles of a client may change.
 */
describe("Read and status roles (e2e)", () => {
    let app: INestApplication<App>;
    let adminToken: string;
    /** Redeemed by a wallet: readers see it. */
    let issuanceSession: string;
    /** Cancelled: readers see it. */
    let presentationSession: string;
    /** Still open for a wallet: hidden from readers of the other side. */
    let openIssuance: string;
    let openPresentation: string;
    let sessionReader: string;
    let verifierReader: string;
    let issuerReader: string;
    let support: string;
    let statusOnly: string;
    let offerOnly: string;
    let auditor: string;
    let keyCustodian: string;

    const as = (token: string) => ({
        get: (path: string) =>
            request(app.getHttpServer())
                .get(path)
                .set("Authorization", `Bearer ${token}`),
        post: (path: string, body: object = {}) =>
            request(app.getHttpServer())
                .post(path)
                .set("Authorization", `Bearer ${token}`)
                .send(body),
        delete: (path: string) =>
            request(app.getHttpServer())
                .delete(path)
                .set("Authorization", `Bearer ${token}`),
    });

    beforeAll(async () => {
        // tenant:admin lets the tenant client grant the new roles.
        ({ app, authToken: adminToken } = await setupIssuanceTestApp({
            extraRoles: [Role.TenantAdmin],
        }));

        await as(adminToken)
            .post("/status-lists", {
                credentialConfigurationId: STATUS_CONFIG,
                bits: 2,
                capacity: 1000,
            })
            .expect(201);
        issuanceSession = (
            await as(adminToken)
                .post("/issuer/offer", {
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "pre_authorized_code",
                    tx_code: "1234",
                })
                .expect(201)
        ).body.session;
        // As if a wallet had redeemed the offer and got a credential with status.
        await app
            .get(StatusListService)
            .createEntry(
                { tenantId: "root", id: issuanceSession } as never,
                STATUS_CONFIG,
            );
        await app
            .get(SessionStore)
            .updateForTenant("root", issuanceSession, { consumed: true });
        const newRequest = async () =>
            (
                await as(adminToken)
                    .post("/verifier/offer", {
                        response_type: ResponseType.URI,
                        requestId: "pid",
                    })
                    .expect(201)
            ).body.session as string;
        presentationSession = await newRequest();
        await as(adminToken)
            .post(`/session/${presentationSession}/cancel`)
            .expect(204);
        openPresentation = await newRequest();
        openIssuance = (
            await as(adminToken)
                .post("/issuer/offer", {
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "pre_authorized_code",
                })
                .expect(201)
        ).body.session;

        const token = (clientId: string, roles: Role[]) =>
            clientToken(app, adminToken, clientId, roles);
        sessionReader = await token("roles-session-reader", [
            Role.SessionsRead,
        ]);
        verifierReader = await token("roles-verifier-reader", [
            Role.PresentationRequest,
            Role.SessionsRead,
        ]);
        issuerReader = await token("roles-issuer-reader", [
            Role.SessionsRead,
            Role.Issuances,
        ]);
        support = await token("roles-support", [
            Role.SessionsRead,
            Role.CredentialStatus,
        ]);
        statusOnly = await token("roles-status", [Role.CredentialStatus]);
        offerOnly = await token("roles-offer", [Role.IssuanceOffer]);
        auditor = await token("roles-auditor", [Role.AuditRead]);
        keyCustodian = await token("roles-keys", [Role.Keys]);
    });

    afterAll(async () => {
        await app?.close();
    });

    describe("sessions:read", () => {
        test("reads sessions, logs and counts of both types once a wallet can no longer use them", async () => {
            const list = await as(sessionReader).get("/session").expect(200);
            const ids = list.body.items.map((item: { id: string }) => item.id);
            expect(ids).toEqual(
                expect.arrayContaining([issuanceSession, presentationSession]),
            );

            for (const id of [issuanceSession, presentationSession]) {
                await as(sessionReader).get(`/session/${id}`).expect(200);
                await as(sessionReader).get(`/session/${id}/logs`).expect(200);
            }

            // The counts include the open sessions; they carry no IDs.
            const stats = await as(sessionReader)
                .get("/session/stats")
                .expect(200);
            expect(stats.body.issuance.total).toBeGreaterThanOrEqual(2);
            expect(stats.body.presentation.total).toBeGreaterThanOrEqual(2);

            await as(sessionReader)
                .get(`/session/${issuanceSession}/credential-status`)
                .expect(200);
        });

        test("does not find the sessions a wallet can still redeem or answer", async () => {
            const list = await as(sessionReader).get("/session").expect(200);
            const ids = list.body.items.map((item: { id: string }) => item.id);
            expect(ids).not.toContain(openIssuance);
            expect(ids).not.toContain(openPresentation);

            const unknown = await as(sessionReader).get(
                `/session/${UNKNOWN_SESSION}`,
            );
            expect(unknown.status).not.toBe(200);
            for (const id of [openIssuance, openPresentation]) {
                for (const path of [
                    `/session/${id}`,
                    `/session/${id}/logs`,
                    `/session/${id}/credential-status`,
                ]) {
                    const read = await as(sessionReader).get(path);
                    expect(read.status, path).toBe(unknown.status);
                }
            }

            // issuance:manage counts toward a side only with a role that
            // cancels sessions, so it opens no pending offer either.
            const asIssuer = await as(issuerReader).get(
                `/session/${openIssuance}`,
            );
            expect(asIssuer.status).toBe(unknown.status);
            const redeemed = await as(issuerReader)
                .get(`/session/${issuanceSession}`)
                .expect(200);
            expect(redeemed.body.offerUrl).toBeUndefined();

            // Its own side stays visible to a client that may change it.
            await as(verifierReader)
                .get(`/session/${openPresentation}`)
                .expect(200);
            const otherSide = await as(verifierReader).get(
                `/session/${openIssuance}`,
            );
            expect(otherSide.status).toBe(unknown.status);
        });

        test("gets no values that redeem an offer or answer a request", async () => {
            const issuance = await as(sessionReader)
                .get(`/session/${issuanceSession}`)
                .expect(200);
            expect(issuance.body.offer).toBeUndefined();
            expect(issuance.body.offerUrl).toBeUndefined();
            expect(issuance.body.credentialPayload).toBeDefined();
            expect(issuance.body.credentialPayload.tx_code).toBeUndefined();

            const presentation = await as(sessionReader)
                .get(`/session/${presentationSession}`)
                .expect(200);
            expect(presentation.body.requestUrl).toBeUndefined();

            // Revoking does not open the offer either.
            const asSupport = await as(support)
                .get(`/session/${issuanceSession}`)
                .expect(200);
            expect(asSupport.body.offerUrl).toBeUndefined();
            expect(asSupport.body.credentialPayload.tx_code).toBeUndefined();

            // The client that may change them still gets them.
            const full = await as(adminToken)
                .get(`/session/${issuanceSession}`)
                .expect(200);
            expect(full.body.offerUrl).toEqual(expect.any(String));
            expect(full.body.credentialPayload.tx_code).toBe("1234");
            const verifier = await as(verifierReader)
                .get(`/session/${openPresentation}`)
                .expect(200);
            expect(verifier.body.requestUrl).toEqual(expect.any(String));
            const otherSide = await as(verifierReader)
                .get(`/session/${issuanceSession}`)
                .expect(200);
            expect(otherSide.body.offerUrl).toBeUndefined();
        });

        test("creates, cancels, deletes and revokes nothing", async () => {
            const attempts = await Promise.all([
                as(sessionReader).delete(`/session/${issuanceSession}`),
                as(sessionReader).post(
                    `/session/${presentationSession}/cancel`,
                ),
                as(sessionReader).post("/session/revoke", {
                    sessionId: issuanceSession,
                    status: 2,
                }),
                as(sessionReader).post("/issuer/offer", {
                    response_type: "uri",
                    credentialConfigurationIds: ["pid-no-key"],
                    flow: "pre_authorized_code",
                }),
                as(sessionReader).post("/verifier/offer", {
                    response_type: ResponseType.URI,
                    requestId: "pid",
                }),
            ]);
            expect(attempts.map((attempt) => attempt.status)).toEqual([
                403, 403, 403, 403, 403,
            ]);

            const kept = await Promise.all(
                [issuanceSession, presentationSession].map((id) =>
                    as(adminToken).get(`/session/${id}`),
                ),
            );
            expect(kept.map((session) => session.status)).toEqual([200, 200]);
        });

        test("does not widen what a verifier may change to issuance sessions", async () => {
            await as(verifierReader)
                .get(`/session/${issuanceSession}`)
                .expect(200);

            // Out of the verifier's scope: like an unknown session.
            const cancel = await as(verifierReader).post(
                `/session/${issuanceSession}/cancel`,
            );
            const cancelUnknown = await as(verifierReader).post(
                `/session/${UNKNOWN_SESSION}/cancel`,
            );
            expect(cancel.status).not.toBe(204);
            expect(cancel.status).toBe(cancelUnknown.status);

            await as(verifierReader)
                .delete(`/session/${issuanceSession}`)
                .expect(204);
            const kept = await as(adminToken)
                .get(`/session/${issuanceSession}`)
                .expect(200);
            expect(kept.body.status).toBe("active");
        });
    });

    describe("credentials:status", () => {
        // Every test starts from valid credentials.
        beforeEach(() =>
            as(adminToken)
                .post("/session/revoke", {
                    sessionId: issuanceSession,
                    status: 0,
                })
                .expect(204),
        );

        test("a client limited to other credential configurations changes no status", async () => {
            const limited = async (
                clientId: string,
                allowedIssuanceConfigs: string[],
            ) => {
                const client = await as(adminToken)
                    .post("/client", {
                        clientId,
                        roles: [Role.CredentialStatus],
                        allowedIssuanceConfigs,
                    })
                    .expect(201);
                const token = await request(app.getHttpServer())
                    .post("/api/oauth2/token")
                    .send({
                        client_id: clientId,
                        client_secret: client.body.clientSecret,
                        grant_type: "client_credentials",
                    })
                    .expect(201);
                return token.body.access_token as string;
            };
            const update = { sessionId: issuanceSession, status: 2 };

            await as(await limited("roles-status-other", ["other-config"]))
                .post("/session/revoke", update)
                .expect(409);
            const unchanged = await as(adminToken)
                .get(`/session/${issuanceSession}/credential-status`)
                .expect(200);
            expect(unchanged.body).toEqual([
                expect.objectContaining({ status: 0 }),
            ]);

            await as(await limited("roles-status-own", [STATUS_CONFIG]))
                .post("/session/revoke", update)
                .expect(204);
        });

        test("issuance:offer reads the credential status but no longer changes it", async () => {
            const status = await as(offerOnly)
                .get(`/session/${issuanceSession}/credential-status`)
                .expect(200);
            expect(status.body).toEqual([
                expect.objectContaining({
                    credentialConfigurationId: STATUS_CONFIG,
                    status: 0,
                }),
            ]);

            await as(offerOnly)
                .post("/session/revoke", {
                    sessionId: issuanceSession,
                    status: 2,
                })
                .expect(403);
        });

        test("changes and reads the status without reading sessions", async () => {
            await as(statusOnly)
                .post("/session/revoke", {
                    sessionId: issuanceSession,
                    status: 2,
                })
                .expect(204);

            const status = await as(statusOnly)
                .get(`/session/${issuanceSession}/credential-status`)
                .expect(200);
            expect(status.body).toEqual([
                expect.objectContaining({ status: 2 }),
            ]);

            await as(statusOnly).get("/session").expect(403);
            await as(statusOnly).get(`/session/${issuanceSession}`).expect(403);
        });

        test("lets support staff look up a session, suspend its credentials and reinstate them", async () => {
            await as(support).get(`/session/${issuanceSession}`).expect(200);
            for (const status of [2, 0]) {
                await as(support)
                    .post("/session/revoke", {
                        sessionId: issuanceSession,
                        status,
                    })
                    .expect(204);
                const read = await as(support)
                    .get(`/session/${issuanceSession}/credential-status`)
                    .expect(200);
                expect(read.body).toEqual([
                    expect.objectContaining({ status }),
                ]);
            }
        });
    });

    describe("audit:read", () => {
        test("reads the audit log and nothing else", async () => {
            const logs = await as(auditor)
                .get("/admin/audit-logs?limit=5")
                .expect(200);
            expect(Array.isArray(logs.body)).toBe(true);

            const refused = await as(auditor).get("/client").expect(403);
            // The Web Client tells a refusal of the role check from other
            // 403s by this text and then suggests a new login.
            expect(refused.body.message).toBe("Forbidden resource");
            await as(auditor).get("/session").expect(403);
        });
    });

    describe("keys:manage", () => {
        test("creates, lists, rotates and deletes key chains", async () => {
            const created = await as(keyCustodian)
                .post("/key-chain", {
                    type: "standalone",
                    usageType: "access",
                    description: "keys:manage e2e",
                })
                .expect(201);
            const id: string = created.body.id;

            const all = await as(keyCustodian).get("/key-chain").expect(200);
            expect(all.body.map((chain: { id: string }) => chain.id)).toContain(
                id,
            );
            await as(keyCustodian).get("/key-chain/providers").expect(200);
            await as(keyCustodian)
                .get("/config-bundles/resources/KeyChain")
                .expect(200);
            await as(keyCustodian).post(`/key-chain/${id}/rotate`).expect(204);
            await as(keyCustodian).delete(`/key-chain/${id}`).expect(204);
        });

        test("neither exports keys nor reads KMS provider settings or other configuration", async () => {
            const [chain] = (
                await as(keyCustodian).get("/key-chain").expect(200)
            ).body;
            const reads = await Promise.all(
                [
                    `/key-chain/${chain.id}/export`,
                    "/key-chain/providers/config",
                    "/issuer/credentials",
                    "/config-bundles/resources/CredentialConfig",
                ].map((path) => as(keyCustodian).get(path)),
            );
            expect(reads.map((read) => read.status)).toEqual([
                403, 403, 403, 403,
            ]);
        });
    });

    test("a caller grants a new role only if it holds it", async () => {
        const manager = await clientToken(app, adminToken, "roles-manager", [
            Role.Clients,
            Role.SessionsRead,
        ]);

        const granted = await as(manager).post("/client", {
            clientId: "roles-granted-reader",
            roles: [Role.SessionsRead],
        });
        expect(granted.status).toBe(201);
        const denied = await as(manager).post("/client", {
            clientId: "roles-granted-status",
            roles: [Role.CredentialStatus],
        });
        expect(denied.status).toBe(403);
        expect(denied.body.message).toContain("credentials:status");
    });
});
