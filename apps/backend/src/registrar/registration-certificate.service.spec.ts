import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registrationCertificateControllerRegister } from "./generated/index.js";
import { RegistrationCertificateService } from "./registration-certificate.service.js";

vi.mock("./generated/index.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./generated/index.js")>()),
    registrationCertificateControllerRegister: vi.fn(),
}));

function unsignedJwt(payload: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

function createService(env: Record<string, unknown> = {}) {
    const configService = { get: (key: string) => env[key] };
    return new RegistrationCertificateService(
        {} as any,
        {} as any,
        configService as any,
        {} as any,
    );
}

const dcqlQuery = {
    credentials: [
        {
            id: "pid",
            format: "dc+sd-jwt",
            meta: { vct_values: ["urn:eudi:pid:1"] },
            claims: [{ path: ["given_name"] }],
        },
    ],
};

const narrowerCertificate = unsignedJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    credentials: [
        {
            format: "dc+sd-jwt",
            meta: { vct_values: ["urn:eudi:pid:1"] },
            claims: [{ path: ["family_name"] }],
        },
    ],
});

describe("RegistrationCertificateService overasking check", () => {
    it("rejects a certificate that does not authorize the requested credentials", async () => {
        await expect(
            createService().resolveRegistrationCertificate(
                { jwt: narrowerCertificate },
                dcqlQuery,
                "r",
                "tenant",
            ),
        ).rejects.toThrow(BadRequestException);
    });

    it("accepts the certificate when SKIP_OVERASKING_CHECK is enabled", async () => {
        const resolved = await createService({
            SKIP_OVERASKING_CHECK: true,
        }).resolveRegistrationCertificate(
            { jwt: narrowerCertificate },
            dcqlQuery,
            "r",
            "tenant",
        );
        expect(resolved.jwt).toBe(narrowerCertificate);
    });

    it("still rejects expired certificates when SKIP_OVERASKING_CHECK is enabled", async () => {
        const expired = unsignedJwt({ exp: 1, credentials: [] });
        await expect(
            createService({
                SKIP_OVERASKING_CHECK: true,
            }).resolveRegistrationCertificate(
                { jwt: expired },
                dcqlQuery,
                "r",
                "tenant",
            ),
        ).rejects.toThrow("Registration certificate is expired");
    });

    it("compares claims by path, as registrar certificates only carry the path", async () => {
        const residentCity = {
            credentials: [
                {
                    id: "pid-sd-jwt",
                    format: "dc+sd-jwt",
                    meta: { vct_values: ["urn:eudi:pid:de:1"] },
                    claims: [{ path: ["address", "locality"] }],
                },
                {
                    id: "pid-mso-mdoc",
                    format: "mso_mdoc",
                    meta: { doctype_value: "eu.europa.ec.eudi.pid.1" },
                    claims: [
                        {
                            id: "city",
                            path: ["eu.europa.ec.eudi.pid.1", "resident_city"],
                            intent_to_retain: false,
                        },
                    ],
                },
                {
                    id: "honorary",
                    format: "dc+sd-jwt",
                    meta: { vct_values: ["urn:de:eaa:ehrenamtskarte:1"] },
                },
            ],
        };
        // Shape produced by the registrar: `claim` with path-only entries.
        const certificate = unsignedJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            credentials: [
                {
                    format: "dc+sd-jwt",
                    meta: { vct_values: ["urn:eudi:pid:de:1"] },
                    claim: [{ path: ["address", "locality"] }],
                },
                {
                    format: "mso_mdoc",
                    meta: { doctype_value: "eu.europa.ec.eudi.pid.1" },
                    claim: [
                        { path: ["eu.europa.ec.eudi.pid.1", "resident_city"] },
                    ],
                },
                {
                    format: "dc+sd-jwt",
                    meta: { vct_values: ["urn:de:eaa:ehrenamtskarte:1"] },
                },
            ],
        });

        const resolved = await createService().resolveRegistrationCertificate(
            { jwt: certificate },
            residentCity,
            "r",
            "tenant",
        );
        expect(resolved.jwt).toBe(certificate);
    });
});

describe("RegistrationCertificateService creation via the registrar", () => {
    const client = {};
    const issued = unsignedJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        credentials: dcqlQuery.credentials,
    });
    let accessCertificateService: {
        findRegistrarAccessCertificateId: ReturnType<typeof vi.fn>;
    };
    let defaults: Record<string, unknown>;
    let service: RegistrationCertificateService;

    beforeEach(() => {
        defaults = {
            privacy_policy: "https://rp.example/privacy",
            support_uri: "https://rp.example/support",
        };
        vi.mocked(registrationCertificateControllerRegister).mockReset();
        vi.mocked(registrationCertificateControllerRegister).mockResolvedValue({
            data: { jwt: issued },
        } as any);
        accessCertificateService = {
            findRegistrarAccessCertificateId: vi
                .fn()
                .mockResolvedValue("ac-signing"),
        };
        service = new RegistrationCertificateService(
            {
                findOneBy: vi.fn().mockImplementation(async () => ({
                    registrationCertificateDefaults: defaults,
                })),
            } as any,
            {
                getClient: vi.fn().mockResolvedValue(client),
                getRelyingPartyId: vi.fn().mockResolvedValue("rp-1"),
            } as any,
            { get: () => undefined } as any,
            accessCertificateService as any,
        );
    });

    const body = { purpose: [{ lang: "en", value: "Age check" }] } as any;

    it("links the access certificate of the access key chain", async () => {
        await service.resolveRegistrationCertificate(
            { body },
            dcqlQuery,
            "r",
            "tenant",
            { accessKeyChainId: "access" },
        );

        expect(
            accessCertificateService.findRegistrarAccessCertificateId,
        ).toHaveBeenCalledWith("tenant", client, "rp-1", "access");
        expect(registrationCertificateControllerRegister).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    rpId: "rp-1",
                    accessCertificateId: "ac-signing",
                }),
            }),
        );
    });

    it("keeps an access certificate named in the registrar defaults", async () => {
        defaults.accessCertificateId = "ac-explicit";
        await service.resolveRegistrationCertificate(
            { body },
            dcqlQuery,
            "r",
            "tenant",
        );

        expect(
            accessCertificateService.findRegistrarAccessCertificateId,
        ).not.toHaveBeenCalled();
        expect(registrationCertificateControllerRegister).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({
                    accessCertificateId: "ac-explicit",
                }),
            }),
        );
    });
});
