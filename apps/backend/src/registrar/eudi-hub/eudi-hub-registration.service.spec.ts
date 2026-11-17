import { BadGatewayException, BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssuanceConfigurationNotFound } from "../../issuer/configuration/issuance/domain/issuance-configuration.js";
import { EudiHubRequestError } from "./eudi-hub.client.js";
import { EudiHubRegistrationService } from "./eudi-hub-registration.service.js";

const ORG = "01932c5a-9abc-7000-8000-000000000010";

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
                registration_cert: { body: { purpose: [] } },
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
                    mode: "generate",
                    privacyPolicy: "https://issuer.example/privacy",
                },
            }),
            storeIssuanceConfiguration: vi.fn().mockResolvedValue({}),
            updateRegistrationCertificateCache: vi
                .fn()
                .mockResolvedValue(undefined),
        };
        service = new EudiHubRegistrationService(
            client as any,
            presentationConfigs as any,
            issuance as any,
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
            // The body stays, the JWT takes precedence over it.
            expect(
                presentationConfigs.updatePresentationConfig,
            ).toHaveBeenCalledWith(
                "age",
                "t1",
                {
                    registration_cert: {
                        body: { purpose: [] },
                        jwt: certificate,
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
    });

    describe("issuer", () => {
        const listing = jwt({
            provides_attestations: [
                { format: "dc+sd-jwt", meta: { vct_values: ["urn:a"] } },
                { format: "mso_mdoc", meta: { doctype_value: "org.b" } },
            ],
        });

        it("registers missing credential types and stores the certificate in import mode", async () => {
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
                        mode: "import",
                        privacyPolicy: "https://issuer.example/privacy",
                        jwt: listing,
                    },
                },
                actor,
            );
            expect(
                issuance.updateRegistrationCertificateCache,
            ).toHaveBeenCalledWith("t1", null);
            expect(result.credentialIssuanceIds).toEqual([
                "ci-existing",
                "ci-org.b",
            ]);
        });

        it("keeps the order of the types when the creations finish out of order", async () => {
            client.createCredentialIssuance.mockImplementation(
                (_t, _o, body) =>
                    new Promise((resolve) =>
                        setTimeout(
                            () => resolve({ id: `ci-${body.credential.type}` }),
                            body.credential.type === "urn:a" ? 20 : 0,
                        ),
                    ),
            );
            client.downloadRegistrationCertificate.mockResolvedValue(listing);

            const result = await service.requestIssuerCertificate(
                "t1",
                base,
                actor,
            );

            expect(result.credentialIssuanceIds).toEqual([
                "ci-urn:a",
                "ci-org.b",
            ]);
        });

        it("requests no certificate when the EUDI Hub refuses to register a type", async () => {
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
                    mode: "import",
                    jwt: listing,
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

        it("succeeds and keeps the stored certificate when the old cache cannot be cleared", async () => {
            client.downloadRegistrationCertificate.mockResolvedValue(listing);
            issuance.updateRegistrationCertificateCache.mockRejectedValue(
                new Error("cache"),
            );

            const result = await service.requestIssuerCertificate(
                "t1",
                base,
                actor,
            );

            expect(result.id).toBe("rc-1");
            expect(issuance.storeIssuanceConfiguration).toHaveBeenCalled();
            expect(client.revokeRegistrationCertificate).not.toHaveBeenCalled();
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
