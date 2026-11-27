import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { PresentationRegistrationCertificateService } from "./presentation-registration-certificate.service.js";

const now = () => Math.floor(Date.now() / 1000);
const unsigned = (payload: Record<string, unknown>) =>
    `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;

const query = (vct: string) => ({
    credentials: [
        {
            id: "pid",
            format: "dc+sd-jwt",
            meta: { vct_values: [vct] },
            claims: [{ path: ["age_over_18"] }],
        },
    ],
});
const certificate = (vct: string, exp = now() + 3600) =>
    unsigned({
        exp,
        credentials: [
            {
                format: "dc+sd-jwt",
                meta: { vct_values: [vct] },
                claims: [{ path: ["age_over_18"] }],
            },
        ],
    });

function setup(skipOveraskingCheck = false) {
    const logger = {
        setContext: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
    const service = new PresentationRegistrationCertificateService(
        {
            publicUrl: "https://eudiplo.example",
            skipOveraskingCheck,
        },
        logger as never,
    );
    return { service, logger };
}

const config = (jwt?: string) => ({
    id: "age",
    tenantId: "t",
    registration_cert: jwt ? { jwt } : null,
});

describe("PresentationRegistrationCertificateService.forRequest", () => {
    it("attaches nothing without a JWT", () => {
        const { service } = setup();
        expect(
            service.forRequest(config(), query("urn:pid"), "r"),
        ).toBeUndefined();
    });

    it("attaches a valid certificate that authorizes the query", () => {
        const { service } = setup();
        const jwt = certificate("urn:pid");
        expect(service.forRequest(config(jwt), query("urn:pid"), "r")).toBe(
            jwt,
        );
    });

    it("refuses a certificate that has expired since it was stored, and logs a warning", () => {
        const { service, logger } = setup();
        expect(() =>
            service.forRequest(
                config(certificate("urn:pid", now() - 3600)),
                query("urn:pid"),
                "r",
            ),
        ).toThrow(BadRequestException);
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
    });

    it("refuses an overasking certificate and logs an error", () => {
        const { service, logger } = setup();
        expect(() =>
            service.forRequest(
                config(certificate("urn:other")),
                query("urn:pid"),
                "r",
            ),
        ).toThrow(BadRequestException);
        expect(logger.error).toHaveBeenCalled();
    });

    it("attaches an overasking certificate with SKIP_OVERASKING_CHECK and warns", () => {
        const { service, logger } = setup(true);
        const jwt = certificate("urn:other");
        expect(service.forRequest(config(jwt), query("urn:pid"), "r")).toBe(
            jwt,
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringMatching(/SKIP_OVERASKING_CHECK/),
        );
    });
});

describe("PresentationRegistrationCertificateService.validate", () => {
    it("checks against the DCQL query with <TENANT_URL> resolved", () => {
        const { service } = setup();
        const vct = "https://eudiplo.example/issuers/t/vct/pid";

        expect(() =>
            service.validate({
                ...config(certificate(vct)),
                dcql_query: query("<TENANT_URL>/vct/pid"),
            }),
        ).not.toThrow();
        expect(() =>
            service.validate({
                ...config(certificate("urn:other")),
                dcql_query: query("<TENANT_URL>/vct/pid"),
            }),
        ).toThrow(BadRequestException);
    });

    it("accepts a configuration without a JWT", () => {
        const { service } = setup();
        expect(() =>
            service.validate({ ...config(), dcql_query: query("urn:pid") }),
        ).not.toThrow();
    });
});
