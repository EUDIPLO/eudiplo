import { setTimeout as sleep } from "node:timers/promises";
import {
    BadGatewayException,
    BadRequestException,
    Logger,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssuanceConfigurationNotFound } from "../../issuer/configuration/issuance/domain/issuance-configuration.js";
import { RegistrationCertificateStorage } from "../registration-certificate-storage.service.js";
import { EudiHubRequestError } from "./eudi-hub.client.js";
import { EUDI_HUB_NO_CERTIFICATE_REQUESTED } from "./eudi-hub-errors.js";
import { EudiHubRegistrationService } from "./eudi-hub-registration.service.js";

// The pause between two creations at the EUDI Hub; tests do not wait for it.
vi.mock("node:timers/promises", () => ({
    setTimeout: vi.fn().mockResolvedValue(undefined),
}));

const ORG = "01932c5a-9abc-7000-8000-000000000010";

/** The `code` of the answer body of an HTTP exception, if it has one. */
function codeOf(error: unknown): unknown {
    const body = (error as BadGatewayException).getResponse();
    return typeof body === "object"
        ? (body as { code?: unknown }).code
        : undefined;
}

/** An unsigned JWT with this payload; the service only decodes it. */
function jwt(payload: Record<string, unknown>): string {
    const part = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "ES256" })}.${part(payload)}.c2ln`;
}

const base = {
    token: "token",
    organizationId: ORG,
    environment: "sandbox" as const,
    identifier: {
        type: "http://data.europa.eu/eudi/id/EUID" as const,
        value: "DE/HRB1",
    },
    serviceDescription: [
        { lang: "de", content: "Dienst" },
        { lang: "en", content: "Service" },
    ],
    supportUri: "https://support.example",
    infoUri: "https://info.example",
};

const presentationRequest = {
    ...base,
    presentationConfigId: "age",
    purpose: [
        { lang: "de", content: "Altersprüfung" },
        { lang: "en", content: "Age check" },
    ],
    privacyPolicy: "https://verifier.example/privacy",
};

const dcql = {
    credentials: [
        {
            id: "pid",
            format: "dc+sd-jwt",
            meta: { vct_values: ["urn:eudi:pid:de:1"] },
            claims: [{ path: ["age_over_18"] }],
        },
    ],
};

const hubCredentials = [
    {
        format: "dc+sd-jwt",
        type: "urn:eudi:pid:de:1",
        claims: [{ path: ["age_over_18"] }],
    },
];

describe("EudiHubRegistrationService", () => {
    let client: Record<string, ReturnType<typeof vi.fn>>;
    let presentationConfigs: Record<string, ReturnType<typeof vi.fn>>;
    let issuance: Record<string, ReturnType<typeof vi.fn>>;
    let service: EudiHubRegistrationService;
    const actor = { entity: { id: "t1" } } as any;

    beforeEach(() => {
        vi.mocked(sleep).mockReset().mockResolvedValue(undefined);
        client = {
            getOrganization: vi.fn(),
            listCredentialRequests: vi.fn().mockResolvedValue([]),
            createCredentialRequest: vi
                .fn()
                .mockResolvedValue({ id: "cr-new" }),
            listCredentialIssuances: vi.fn().mockResolvedValue([]),
            createCredentialIssuance: vi
                .fn()
                .mockImplementation((_t, _o, body) =>
                    Promise.resolve({ id: `ci-${body.credential.type}` }),
                ),
            createRegistrationCertificate: vi.fn().mockResolvedValue({
                id: "rc-1",
                expirationDate: "2027-01-01T00:00:00Z",
            }),
            downloadRegistrationCertificate: vi
                .fn()
                .mockResolvedValue(jwt({ credentials: [] })),
            revokeRegistrationCertificate: vi.fn().mockResolvedValue(undefined),
        };
        presentationConfigs = {
            getPresentationConfig: vi.fn().mockResolvedValue({
                id: "age",
                description: "Age check",
                dcql_query: dcql,
            }),
            updatePresentationConfig: vi.fn().mockResolvedValue({}),
        };
        issuance = {
            registrationCertificateMaterial: vi.fn().mockResolvedValue({
                providesAttestations: [
                    { format: "dc+sd-jwt", type: "urn:a" },
                    { format: "mso_mdoc", type: "org.b" },
                ],
            }),
            getIssuanceConfiguration: vi.fn().mockResolvedValue({
                registrationCertificate: {
                    enabled: true,
                    privacyPolicy: "https://issuer.example/privacy",
                },
            }),
            storeIssuanceConfiguration: vi.fn().mockResolvedValue({}),
        };
        service = new EudiHubRegistrationService(
            client as any,
            new RegistrationCertificateStorage(
                presentationConfigs as any,
                issuance as any,
                {
                    publicUrl: "https://eudiplo.example",
                    skipTrustAuthority: false,
                    skipOveraskingCheck: false,
                },
            ),
        );
    });

    describe("verifier", () => {
        it("registers the DCQL query, requests the certificate and stores its JWT", async () => {
            const certificate = jwt({ credentials: [] });
            client.downloadRegistrationCertificate.mockResolvedValue(
                certificate,
            );

            const result = await service.requestPresentationCertificate(
                "t1",
                presentationRequest,
                actor,
            );

            // Only requests of the same environment are used again.
            expect(client.listCredentialRequests).toHaveBeenCalledWith(
                "token",
                ORG,
                "sandbox",
            );
            expect(client.createCredentialRequest).toHaveBeenCalledWith(
                "token",
                ORG,
                {
                    name: "Age check",
                    credentials: hubCredentials,
                    purpose: presentationRequest.purpose,
                    privacyPolicy: presentationRequest.privacyPolicy,
                    environments: ["sandbox"],
                },
            );
            expect(client.createRegistrationCertificate).toHaveBeenCalledWith(
                "token",
                ORG,
                {
                    name: "Age check",
                    environment: "sandbox",
                    identifier: base.identifier,
                    serviceDescription: base.serviceDescription,
                    supportUri: base.supportUri,
                    infoUri: base.infoUri,
                    type: "credentialRequest",
                    credentialRequestId: "cr-new",
                },
            );
            // The purpose and privacy policy are kept for the next request.
            expect(
                presentationConfigs.updatePresentationConfig,
            ).toHaveBeenCalledWith(
                "age",
                "t1",
                {
                    registration_cert: {
                        jwt: certificate,
                        purpose: presentationRequest.purpose,
                        privacy_policy: presentationRequest.privacyPolicy,
                    },
                },
                actor,
            );
            expect(result).toEqual({
                id: "rc-1",
                environment: "sandbox",
                expirationDate: "2027-01-01T00:00:00Z",
                credentialRequestId: "cr-new",
                reusedCredentialRequest: false,
            });
        });

        it("reuses a credential request when the purposes differ only in texts that are not sent", async () => {
            client.listCredentialRequests.mockResolvedValue([
                {
                    id: "cr-same",
                    credentials: hubCredentials,
                    purpose: presentationRequest.purpose,
                    privacyPolicy: presentationRequest.privacyPolicy,
                },
            ]);

            const result = await service.requestPresentationCertificate(
                "t1",
                {
                    ...presentationRequest,
                    purpose: [
                        ...presentationRequest.purpose,
                        { lang: "pt-BR", content: "Verificação de idade" },
                    ],
                },
                actor,
            );

            expect(client.createCredentialRequest).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                credentialRequestId: "cr-same",
                reusedCredentialRequest: true,
            });
        });

        it("uses a credential request with the same credentials, purpose and privacy policy again", async () => {
            client.listCredentialRequests.mockResolvedValue([
                {
                    id: "cr-other",
                    credentials: hubCredentials,
                    purpose: presentationRequest.purpose,
                    privacyPolicy: "https://other.example",
                },
                {
                    id: "cr-same",
                    credentials: hubCredentials,
                    purpose: [...presentationRequest.purpose].reverse(),
                    privacyPolicy: presentationRequest.privacyPolicy,
                },
            ]);

            const result = await service.requestPresentationCertificate(
                "t1",
                presentationRequest,
                actor,
            );

            expect(client.createCredentialRequest).not.toHaveBeenCalled();
            expect(result).toMatchObject({
                credentialRequestId: "cr-same",
                reusedCredentialRequest: true,
            });
        });

        it("takes the purpose and privacy policy kept in the configuration when the request leaves them out", async () => {
            presentationConfigs.getPresentationConfig.mockResolvedValue({
                id: "age",
                description: "Age check",
                dcql_query: dcql,
                registration_cert: {
                    jwt: "old",
                    purpose: presentationRequest.purpose,
                    privacy_policy: presentationRequest.privacyPolicy,
                },
            });
            const { purpose, privacyPolicy, ...renewal } = presentationRequest;

            await service.requestPresentationCertificate("t1", renewal, actor);

            expect(
                client.createCredentialRequest.mock.lastCall?.[2],
            ).toMatchObject({ purpose, privacyPolicy });
            expect(
                presentationConfigs.updatePresentationConfig.mock.lastCall?.[2],
            ).toEqual({
                registration_cert: {
                    jwt: expect.any(String),
                    purpose,
                    privacy_policy: privacyPolicy,
                },
            });
        });

        it("refuses without a purpose or privacy policy before calling the EUDI Hub", async () => {
            const { purpose: _, ...withoutPurpose } = presentationRequest;

            await expect(
                service.requestPresentationCertificate(
                    "t1",
                    withoutPurpose,
                    actor,
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(client.listCredentialRequests).not.toHaveBeenCalled();
        });

        it("refuses a kept purpose without German and English text", async () => {
            presentationConfigs.getPresentationConfig.mockResolvedValue({
                id: "age",
                dcql_query: dcql,
                registration_cert: {
                    purpose: [{ lang: "fr", content: "Contrôle d'âge" }],
                    privacy_policy: presentationRequest.privacyPolicy,
                },
            });
            const { purpose: _, ...withoutPurpose } = presentationRequest;

            await expect(
                service.requestPresentationCertificate(
                    "t1",
                    withoutPurpose,
                    actor,
                ),
            ).rejects.toThrow(/German \(de\) and an English \(en\)/);
            expect(client.listCredentialRequests).not.toHaveBeenCalled();
        });

        it("refuses a kept privacy policy that is no http or https URL", async () => {
            presentationConfigs.getPresentationConfig.mockResolvedValue({
                id: "age",
                dcql_query: dcql,
                registration_cert: {
                    purpose: presentationRequest.purpose,
                    privacy_policy: "privacy.html",
                },
            });
            const { privacyPolicy: _, ...withoutPolicy } = presentationRequest;

            await expect(
                service.requestPresentationCertificate(
                    "t1",
                    withoutPolicy,
                    actor,
                ),
            ).rejects.toThrow(/not an http or https URL/);
            expect(client.listCredentialRequests).not.toHaveBeenCalled();
        });

        it("stores every purpose text but sends the EUDI Hub only those with two-letter codes", async () => {
            const purpose = [
                ...presentationRequest.purpose,
                { lang: "pt-BR", content: "Verificação de idade" },
            ];

            await service.requestPresentationCertificate(
                "t1",
                { ...presentationRequest, purpose },
                actor,
            );

            expect(
                client.createCredentialRequest.mock.lastCall?.[2].purpose,
            ).toEqual(presentationRequest.purpose);
            expect(
                presentationConfigs.updatePresentationConfig.mock.lastCall?.[2]
                    .registration_cert.purpose,
            ).toEqual(purpose);
        });

        it("keeps a stored regional purpose when renewing without a purpose", async () => {
            const purpose = [
                ...presentationRequest.purpose,
                { lang: "pt-BR", content: "Verificação de idade" },
            ];
            presentationConfigs.getPresentationConfig.mockResolvedValue({
                id: "age",
                dcql_query: dcql,
                registration_cert: {
                    jwt: "old",
                    purpose,
                    privacy_policy: presentationRequest.privacyPolicy,
                },
            });
            const { purpose: _, ...renewal } = presentationRequest;

            await service.requestPresentationCertificate("t1", renewal, actor);

            expect(
                presentationConfigs.updatePresentationConfig.mock.lastCall?.[2]
                    .registration_cert.purpose,
            ).toEqual(purpose);
        });

        it("registers the DCQL query with <TENANT_URL> resolved", async () => {
            presentationConfigs.getPresentationConfig.mockResolvedValue({
                id: "age",
                dcql_query: {
                    credentials: [
                        {
                            ...dcql.credentials[0],
                            meta: { vct_values: ["<TENANT_URL>/vct/pid"] },
                        },
                    ],
                },
            });

            await service.requestPresentationCertificate(
                "t1",
                presentationRequest,
                actor,
            );

            expect(
                client.createCredentialRequest.mock.lastCall?.[2].credentials[0]
                    .type,
            ).toBe("https://eudiplo.example/issuers/t1/vct/pid");
        });

        it("names the request after the configuration's ID without a description", async () => {
            presentationConfigs.getPresentationConfig.mockResolvedValue({
                id: "age",
                description: "  ",
                dcql_query: dcql,
            });

            await service.requestPresentationCertificate(
                "t1",
                presentationRequest,
                actor,
            );

            expect(client.createCredentialRequest.mock.lastCall?.[2].name).toBe(
                "age",
            );
            expect(
                client.createRegistrationCertificate.mock.lastCall?.[2].name,
            ).toBe("age");
        });

        it("refuses a DCQL query the EUDI Hub cannot register before calling it", async () => {
            presentationConfigs.getPresentationConfig.mockResolvedValue({
                id: "age",
                dcql_query: {
                    credentials: [
                        {
                            ...dcql.credentials[0],
                            meta: { vct_values: ["a", "b"] },
                        },
                    ],
                },
            });

            await expect(
                service.requestPresentationCertificate(
                    "t1",
                    presentationRequest,
                    actor,
                ),
            ).rejects.toThrow(/one vct per credential/);
            expect(client.listCredentialRequests).not.toHaveBeenCalled();
        });

        it("revokes a certificate the configuration refuses to store", async () => {
            presentationConfigs.updatePresentationConfig.mockRejectedValue(
                new BadRequestException(
                    "does not authorize the requested DCQL credentials",
                ),
            );

            await expect(
                service.requestPresentationCertificate(
                    "t1",
                    presentationRequest,
                    actor,
                ),
            ).rejects.toThrow("does not authorize");
            expect(client.revokeRegistrationCertificate).toHaveBeenCalledWith(
                "token",
                ORG,
                "rc-1",
            );
        });

        it("revokes a certificate that cannot be downloaded", async () => {
            client.downloadRegistrationCertificate.mockRejectedValue(
                new EudiHubRequestError("no answer"),
            );

            await expect(
                service.requestPresentationCertificate(
                    "t1",
                    presentationRequest,
                    actor,
                ),
            ).rejects.toBeInstanceOf(BadGatewayException);
            expect(client.revokeRegistrationCertificate).toHaveBeenCalled();
            expect(
                presentationConfigs.updatePresentationConfig,
            ).not.toHaveBeenCalled();
        });

        it("reports a refused token as 400 without revoking anything", async () => {
            client.listCredentialRequests.mockRejectedValue(
                new EudiHubRequestError("refused", { status: 401 }),
            );

            await expect(
                service.requestPresentationCertificate(
                    "t1",
                    presentationRequest,
                    actor,
                ),
            ).rejects.toThrow(/copy a fresh one/);
            expect(client.revokeRegistrationCertificate).not.toHaveBeenCalled();
        });

        it.each([
            ["listing", "listCredentialRequests"],
            ["creating", "createCredentialRequest"],
        ] as const)(
            "says no certificate was requested when %s the credential request fails",
            async (_case, method) => {
                client.listCredentialRequests.mockResolvedValue([]);
                client[method].mockRejectedValue(
                    new EudiHubRequestError("down", { status: 503 }),
                );

                const error = await service
                    .requestPresentationCertificate(
                        "t1",
                        presentationRequest,
                        actor,
                    )
                    .catch((caught: unknown) => caught);

                expect(error).toBeInstanceOf(BadGatewayException);
                expect((error as BadGatewayException).message).toBe(
                    "Could not find or register the credential request at the EUDI Hub: the EUDI Hub answered with HTTP 503.",
                );
                expect(codeOf(error)).toBe(EUDI_HUB_NO_CERTIFICATE_REQUESTED);
                expect(
                    client.createRegistrationCertificate,
                ).not.toHaveBeenCalled();
            },
        );

        it("does not say no certificate was requested when requesting it fails", async () => {
            client.createRegistrationCertificate.mockRejectedValue(
                new EudiHubRequestError("down", { status: 503 }),
            );

            const error = await service
                .requestPresentationCertificate(
                    "t1",
                    presentationRequest,
                    actor,
                )
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(BadGatewayException);
            expect(codeOf(error)).toBeUndefined();
        });
    });

    describe("issuer", () => {
        const listing = jwt({
            provides_attestations: [
                { format: "dc+sd-jwt", meta: { vct_values: ["urn:a"] } },
                { format: "mso_mdoc", meta: { doctype_value: "org.b" } },
            ],
        });

        it("registers missing credential types and stores the certificate", async () => {
            client.listCredentialIssuances.mockResolvedValue([
                {
                    id: "ci-existing",
                    credential: { format: "dc+sd-jwt", type: "urn:a" },
                },
                {
                    id: "ci-wrong-format",
                    credential: { format: "dc+sd-jwt", type: "org.b" },
                },
            ]);
            client.downloadRegistrationCertificate.mockResolvedValue(listing);

            const result = await service.requestIssuerCertificate(
                "t1",
                base,
                actor,
            );

            expect(client.listCredentialIssuances).toHaveBeenCalledWith(
                "token",
                ORG,
                "sandbox",
            );
            expect(client.createCredentialIssuance).toHaveBeenCalledTimes(1);
            // The existing type comes first: no pause before the only creation.
            expect(sleep).not.toHaveBeenCalled();
            expect(client.createCredentialIssuance).toHaveBeenCalledWith(
                "token",
                ORG,
                {
                    name: "org.b",
                    credential: { format: "mso_mdoc", type: "org.b" },
                    environments: ["sandbox"],
                },
            );
            expect(
                client.createRegistrationCertificate.mock.lastCall?.[2],
            ).toMatchObject({
                type: "credentialIssuance",
                credentialIssuanceIds: ["ci-existing", "ci-org.b"],
            });
            expect(issuance.storeIssuanceConfiguration).toHaveBeenCalledWith(
                "t1",
                {
                    registrationCertificate: {
                        enabled: true,
                        privacyPolicy: "https://issuer.example/privacy",
                        jwt: listing,
                        supportUri: base.supportUri,
                    },
                },
                actor,
            );
            expect(result.credentialIssuanceIds).toEqual([
                "ci-existing",
                "ci-org.b",
            ]);
        });

        it("creates the missing types one after another with a pause between them", async () => {
            issuance.registrationCertificateMaterial.mockResolvedValue({
                providesAttestations: [
                    { format: "dc+sd-jwt", type: "urn:a" },
                    { format: "dc+sd-jwt", type: "urn:existing" },
                    { format: "mso_mdoc", type: "org.b" },
                    { format: "dc+sd-jwt", type: "urn:c" },
                ],
            });
            client.listCredentialIssuances.mockResolvedValue([
                {
                    id: "ci-existing",
                    credential: { format: "dc+sd-jwt", type: "urn:existing" },
                },
            ]);
            const events: string[] = [];
            let running = 0;
            let mostRunning = 0;
            vi.mocked(sleep).mockImplementation(async (ms) => {
                events.push(`pause ${ms}`);
                return undefined;
            });
            client.createCredentialIssuance.mockImplementation(
                async (_t, _o, body) => {
                    running++;
                    mostRunning = Math.max(mostRunning, running);
                    events.push(`create ${body.credential.type}`);
                    // Stays running across a real tick, so parallel
                    // creations would overlap and raise mostRunning.
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    running--;
                    return { id: `ci-${body.credential.type}` };
                },
            );
            client.createRegistrationCertificate.mockRejectedValue(
                new EudiHubRequestError("stop", { status: 400 }),
            );

            await expect(
                service.requestIssuerCertificate("t1", base, actor),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(mostRunning).toBe(1);
            expect(events).toEqual([
                "create urn:a",
                "pause 300",
                "create org.b",
                "pause 300",
                "create urn:c",
            ]);
            expect(
                client.createRegistrationCertificate.mock.lastCall?.[2],
            ).toMatchObject({
                credentialIssuanceIds: [
                    "ci-urn:a",
                    "ci-existing",
                    "ci-org.b",
                    "ci-urn:c",
                ],
            });
        });

        it("requests no certificate when the EUDI Hub fails to register a type", async () => {
            client.createCredentialIssuance.mockImplementation(
                (_t, _o, body) =>
                    body.credential.type === "org.b"
                        ? Promise.reject(
                              new EudiHubRequestError("down", { status: 503 }),
                          )
                        : Promise.resolve({ id: "ci-urn:a" }),
            );

            await expect(
                service.requestIssuerCertificate("t1", base, actor),
            ).rejects.toBeInstanceOf(BadGatewayException);
            expect(client.createRegistrationCertificate).not.toHaveBeenCalled();
            expect(client.revokeRegistrationCertificate).not.toHaveBeenCalled();
            expect(issuance.storeIssuanceConfiguration).not.toHaveBeenCalled();
        });

        it("names the credential type the EUDI Hub refused", async () => {
            client.createCredentialIssuance.mockImplementation(
                (_t, _o, body) =>
                    body.credential.type === "org.b"
                        ? Promise.reject(
                              new EudiHubRequestError("conflict", {
                                  status: 409,
                                  detail: "A credential issuance with the same credential already exists in the registry",
                              }),
                          )
                        : Promise.resolve({ id: "ci-urn:a" }),
            );

            const error = await service
                .requestIssuerCertificate("t1", base, actor)
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(BadRequestException);
            expect((error as BadRequestException).message).toBe(
                "The EUDI Hub did not register credential type org.b for the registration certificate: the EUDI Hub answered with HTTP 409 (A credential issuance with the same credential already exists in the registry).",
            );
            expect(client.createRegistrationCertificate).not.toHaveBeenCalled();
        });

        it("names every refused type and logs the reasons of the others", async () => {
            const warn = vi.spyOn(Logger.prototype, "warn");
            client.createCredentialIssuance.mockImplementation((_t, _o, body) =>
                Promise.reject(
                    new EudiHubRequestError(
                        `conflict ${body.credential.type}`,
                        { status: 409 },
                    ),
                ),
            );

            try {
                await expect(
                    service.requestIssuerCertificate("t1", base, actor),
                ).rejects.toThrow(
                    "The EUDI Hub did not register credential type urn:a for the registration certificate (nor org.b): the EUDI Hub answered with HTTP 409.",
                );
                expect(warn).toHaveBeenCalledWith(
                    "[t1] The EUDI Hub did not register credential type org.b: conflict org.b",
                );
            } finally {
                warn.mockRestore();
            }
        });

        it("pauses after a refused type and still creates the remaining ones", async () => {
            const events: string[] = [];
            vi.mocked(sleep).mockImplementation(async (ms) => {
                events.push(`pause ${ms}`);
                return undefined;
            });
            client.createCredentialIssuance.mockImplementation(
                (_t, _o, body) => {
                    events.push(`create ${body.credential.type}`);
                    return body.credential.type === "urn:a"
                        ? Promise.reject(
                              new EudiHubRequestError("conflict", {
                                  status: 409,
                              }),
                          )
                        : Promise.resolve({ id: "ci-org.b" });
                },
            );

            await expect(
                service.requestIssuerCertificate("t1", base, actor),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(events).toEqual([
                "create urn:a",
                "pause 300",
                "create org.b",
            ]);
        });

        it("answers with a 502 when the EUDI Hub failed for one type and refused another", async () => {
            client.createCredentialIssuance.mockImplementation((_t, _o, body) =>
                Promise.reject(
                    body.credential.type === "urn:a"
                        ? new EudiHubRequestError("conflict", {
                              status: 409,
                          })
                        : new EudiHubRequestError("down", { status: 503 }),
                ),
            );

            const error = await service
                .requestIssuerCertificate("t1", base, actor)
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(BadGatewayException);
            expect((error as BadGatewayException).message).toBe(
                "The EUDI Hub did not register credential type org.b for the registration certificate (nor urn:a): the EUDI Hub answered with HTTP 503.",
            );
            expect(codeOf(error)).toBe(EUDI_HUB_NO_CERTIFICATE_REQUESTED);
        });

        it.each([
            [
                "an invalid answer",
                new EudiHubRequestError("no id", { invalidAnswer: true }),
            ],
            ["no answer", new EudiHubRequestError("reset")],
            ["an unexpected error", new TypeError("boom")],
        ])(
            "answers with a 502 when the EUDI Hub gave %s for one type and refused another",
            async (_case, failure) => {
                client.createCredentialIssuance.mockImplementation(
                    (_t, _o, body) =>
                        Promise.reject(
                            body.credential.type === "urn:a"
                                ? new EudiHubRequestError("conflict", {
                                      status: 409,
                                  })
                                : failure,
                        ),
                );

                const error = await service
                    .requestIssuerCertificate("t1", base, actor)
                    .catch((caught: unknown) => caught);

                expect(error).toBeInstanceOf(BadGatewayException);
                expect((error as BadGatewayException).message).toMatch(
                    /^The EUDI Hub did not register credential type org\.b for the registration certificate \(nor urn:a\)/,
                );
                expect(codeOf(error)).toBe(EUDI_HUB_NO_CERTIFICATE_REQUESTED);
            },
        );

        it.each([
            [
                "a server error",
                new EudiHubRequestError("down", { status: 503 }),
            ],
            ["no answer", new EudiHubRequestError("reset")],
        ])(
            "answers with a 502 when listing the credential issuances gets %s",
            async (_case, failure) => {
                client.listCredentialIssuances.mockRejectedValue(failure);

                const error = await service
                    .requestIssuerCertificate("t1", base, actor)
                    .catch((caught: unknown) => caught);

                expect(error).toBeInstanceOf(BadGatewayException);
                expect((error as BadGatewayException).message).toMatch(
                    /^Could not read the credential issuances at the EUDI Hub: /,
                );
                expect(codeOf(error)).toBe(EUDI_HUB_NO_CERTIFICATE_REQUESTED);
                expect(client.createCredentialIssuance).not.toHaveBeenCalled();
            },
        );

        it("does not say no certificate was requested when requesting it fails", async () => {
            client.createRegistrationCertificate.mockRejectedValue(
                new EudiHubRequestError("reset"),
            );

            const error = await service
                .requestIssuerCertificate("t1", base, actor)
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(BadGatewayException);
            expect(codeOf(error)).toBeUndefined();
        });

        it("says nothing about a certificate in a refusal before requesting one", async () => {
            client.listCredentialIssuances.mockRejectedValue(
                new EudiHubRequestError("refused", { status: 401 }),
            );

            const error = await service
                .requestIssuerCertificate("t1", base, actor)
                .catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(BadRequestException);
            expect(codeOf(error)).toBeUndefined();
        });

        it("reports a refused token when the credential issuances cannot be listed", async () => {
            client.listCredentialIssuances.mockRejectedValue(
                new EudiHubRequestError("refused", { status: 401 }),
            );

            await expect(
                service.requestIssuerCertificate("t1", base, actor),
            ).rejects.toThrow(
                /^Could not read the credential issuances at the EUDI Hub: .*copy a fresh one\.$/,
            );
            expect(client.createCredentialIssuance).not.toHaveBeenCalled();
            expect(client.createRegistrationCertificate).not.toHaveBeenCalled();
        });

        it("refuses without credential types", async () => {
            issuance.registrationCertificateMaterial.mockResolvedValue({
                providesAttestations: [],
            });

            await expect(
                service.requestIssuerCertificate("t1", base, actor),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(client.listCredentialIssuances).not.toHaveBeenCalled();
        });

        it("revokes a certificate that does not list every type", async () => {
            client.downloadRegistrationCertificate.mockResolvedValue(
                jwt({
                    provides_attestations: [
                        {
                            format: "dc+sd-jwt",
                            meta: { vct_values: ["urn:a"] },
                        },
                    ],
                }),
            );

            await expect(
                service.requestIssuerCertificate("t1", base, actor),
            ).rejects.toThrow(/does not list org\.b/);
            expect(client.revokeRegistrationCertificate).toHaveBeenCalled();
            expect(issuance.storeIssuanceConfiguration).not.toHaveBeenCalled();
        });

        it("stores the certificate when no issuance configuration exists yet", async () => {
            issuance.getIssuanceConfiguration.mockRejectedValue(
                new IssuanceConfigurationNotFound("t1"),
            );
            client.downloadRegistrationCertificate.mockResolvedValue(listing);

            await service.requestIssuerCertificate("t1", base, actor);

            expect(
                issuance.storeIssuanceConfiguration.mock.lastCall?.[1],
            ).toEqual({
                registrationCertificate: {
                    enabled: true,
                    jwt: listing,
                    supportUri: base.supportUri,
                },
            });
        });

        it("revokes a certificate whose download is no JWT", async () => {
            client.downloadRegistrationCertificate.mockRejectedValue(
                new EudiHubRequestError("no JWT", { invalidAnswer: true }),
            );

            await expect(
                service.requestIssuerCertificate("t1", base, actor),
            ).rejects.toBeInstanceOf(BadGatewayException);
            expect(client.revokeRegistrationCertificate).toHaveBeenCalledWith(
                "token",
                ORG,
                "rc-1",
            );
            expect(issuance.storeIssuanceConfiguration).not.toHaveBeenCalled();
        });

        it("does not overwrite the settings when the issuance configuration cannot be read", async () => {
            client.downloadRegistrationCertificate.mockResolvedValue(listing);
            issuance.getIssuanceConfiguration.mockRejectedValue(
                new Error("database down"),
            );

            await expect(
                service.requestIssuerCertificate("t1", base, actor),
            ).rejects.toThrow("database down");
            expect(issuance.storeIssuanceConfiguration).not.toHaveBeenCalled();
            expect(client.revokeRegistrationCertificate).toHaveBeenCalled();
        });

        it("revokes a certificate that cannot be stored", async () => {
            client.downloadRegistrationCertificate.mockResolvedValue(listing);
            issuance.storeIssuanceConfiguration.mockRejectedValue(
                new BadRequestException("invalid"),
            );

            await expect(
                service.requestIssuerCertificate("t1", base, actor),
            ).rejects.toThrow("invalid");
            expect(client.revokeRegistrationCertificate).toHaveBeenCalled();
        });
    });
});
