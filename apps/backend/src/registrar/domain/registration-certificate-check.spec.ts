import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { beforeAll, describe, expect, it } from "vitest";
import { checkRegistrationCertificate } from "./registration-certificate-check.js";

function unsignedJwt(payload: Record<string, unknown>): string {
    const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${encode({ alg: "none" })}.${encode(payload)}.`;
}

const now = 1_800_000_000;
const pid = {
    format: "dc+sd-jwt",
    meta: { vct_values: ["urn:eudi:pid:1"] },
};
const dcqlQuery = {
    credentials: [
        {
            id: "pid",
            ...pid,
            claims: [{ path: ["given_name"] }, { path: ["family_name"] }],
        },
    ],
};
const certificate = (claims: string[][], extra: object = {}) =>
    unsignedJwt({
        credentials: [{ ...pid, claim: claims.map((path) => ({ path })) }],
        ...extra,
    });
const check = (jwt: string, skipOveraskingCheck = false) =>
    checkRegistrationCertificate(jwt, dcqlQuery, { skipOveraskingCheck, now });

describe("checkRegistrationCertificate", () => {
    it("returns the payload of a certificate covering the request in any claim order", () => {
        const result = check(
            certificate([["family_name"], ["given_name"]], { exp: now + 10 }),
        );
        expect(result.problem).toBeUndefined();
        expect(result.payload?.exp).toBe(now + 10);
    });

    it("refuses a value that is not a JWT", () => {
        expect(check("not-a-jwt").problem).toEqual({
            code: "INVALID_JWT",
            message: "Registration certificate is not a valid JWT",
        });
    });

    it("tolerates 60 seconds of clock skew on exp and nbf", () => {
        const claims = [["given_name"], ["family_name"]];
        expect(
            check(certificate(claims, { exp: now - 60 })).problem,
        ).toBeUndefined();
        expect(
            check(certificate(claims, { nbf: now + 60 })).problem,
        ).toBeUndefined();
        expect(check(certificate(claims, { exp: now - 61 })).problem).toEqual({
            code: "EXPIRED",
            message: "Registration certificate is expired",
        });
        expect(check(certificate(claims, { nbf: now + 61 })).problem).toEqual({
            code: "NOT_YET_VALID",
            message: "Registration certificate is not yet valid",
        });
    });

    it("refuses a certificate without authorized credentials", () => {
        expect(check(unsignedJwt({})).problem).toEqual({
            code: "NO_AUTHORIZED_CREDENTIALS",
            message: "Registration certificate has no authorized credentials",
        });
    });

    it("refuses overasking and names the unauthorized credential queries", () => {
        expect(check(certificate([["given_name"]])).problem).toEqual({
            code: "OVERASKING",
            message:
                "Registration certificate does not authorize the requested DCQL credentials",
            unauthorizedCredentialIds: ["pid"],
        });
    });

    it("skips the overasking check when asked to, but not the time check", () => {
        expect(
            check(certificate([["given_name"]]), true).problem,
        ).toBeUndefined();
        expect(
            check(certificate([], { exp: now - 3600 }), true).problem?.code,
        ).toBe("EXPIRED");
    });

    it("accepts any certificate for a query without credentials", () => {
        expect(
            checkRegistrationCertificate(unsignedJwt({}), undefined, {
                skipOveraskingCheck: false,
                now,
            }).problem,
        ).toBeUndefined();
    });
});

describe("checkRegistrationCertificate access certificate match", () => {
    const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const crypto = webcrypto as Crypto;

    async function accessCertificate(name: string): Promise<string> {
        const keys = (await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ])) as CryptoKeyPair;
        const cert = await x509.X509CertificateGenerator.createSelfSigned(
            {
                serialNumber: "01",
                name,
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 3_600_000),
                signingAlgorithm: algorithm,
                keys,
            },
            crypto,
        );
        return cert.toString("pem");
    }

    let legalPerson: string;
    let naturalPerson: string;
    let withoutIdentifier: string;
    beforeAll(async () => {
        legalPerson = await accessCertificate(
            "CN=Example, O=Example GmbH, 2.5.4.97=LEIXG-529900T8BM49AURSDO55, C=DE",
        );
        naturalPerson = await accessCertificate(
            "CN=Erika, 2.5.4.42=Erika, 2.5.4.4=Mustermann, 2.5.4.5=TINDE-123456789, C=DE",
        );
        withoutIdentifier = await accessCertificate("CN=localhost");
    });

    const matched = (extra: object, accessCertificate: string) =>
        checkRegistrationCertificate(
            certificate([["given_name"], ["family_name"]], extra),
            dcqlQuery,
            { skipOveraskingCheck: false, accessCertificate, now },
        );

    it("accepts a certificate whose sub (v1.2.1) is the organizationIdentifier", () => {
        expect(
            matched({ sub: "LEIXG-529900T8BM49AURSDO55" }, legalPerson).problem,
        ).toBeUndefined();
        expect(
            matched({ sub: "VATDE-999999999" }, legalPerson).problem?.message,
        ).toContain("its sub is 'VATDE-999999999'");
    });

    it("matches intermediary.sub (v1.2.1) instead of sub when an intermediary is named", () => {
        expect(
            matched(
                {
                    sub: "VATDE-999999999",
                    intermediary: {
                        sub: "LEIXG-529900T8BM49AURSDO55",
                        sname: "Example",
                    },
                },
                legalPerson,
            ).problem,
        ).toBeUndefined();
        expect(
            matched(
                {
                    sub: "LEIXG-529900T8BM49AURSDO55",
                    intermediary: { sub: "VATDE-1", sname: "Other" },
                },
                legalPerson,
            ).problem?.message,
        ).toContain("its intermediary.sub is 'VATDE-1'");
        expect(
            matched(
                {
                    sub: "LEIXG-529900T8BM49AURSDO55",
                    intermediary: { sname: "Other" },
                },
                legalPerson,
            ).problem?.message,
        ).toContain("no intermediary.sub");
    });

    it("accepts a certificate whose sub.id is the organizationIdentifier", () => {
        expect(
            matched(
                {
                    sub: {
                        legal_name: "Example GmbH",
                        id: "LEIXG-529900T8BM49AURSDO55",
                    },
                },
                legalPerson,
            ).problem,
        ).toBeUndefined();
    });

    it("accepts a certificate whose sub.id is the serialNumber of a natural person", () => {
        expect(
            matched({ sub: { id: "TINDE-123456789" } }, naturalPerson).problem,
        ).toBeUndefined();
    });

    it("does not take the serialNumber of a legal person's access certificate", async () => {
        const legalWithSerial = await accessCertificate(
            "CN=Example, 2.5.4.97=LEIXG-529900T8BM49AURSDO55, 2.5.4.5=VATDE-1",
        );
        expect(
            matched({ sub: { id: "VATDE-1" } }, legalWithSerial).problem?.code,
        ).toBe("ACCESS_CERTIFICATE_MISMATCH");
    });

    it("accepts several identifiers when one matches", () => {
        expect(
            matched(
                { sub: { id: ["VATDE-1", "LEIXG-529900T8BM49AURSDO55"] } },
                legalPerson,
            ).problem,
        ).toBeUndefined();
    });

    it("refuses a certificate issued to another relying party", () => {
        const { problem } = matched(
            { sub: { id: "VATDE-999999999" } },
            legalPerson,
        );
        expect(problem?.code).toBe("ACCESS_CERTIFICATE_MISMATCH");
        expect(problem?.message).toContain("'VATDE-999999999'");
        expect(problem?.message).toContain("'LEIXG-529900T8BM49AURSDO55'");
    });

    it("refuses when the access certificate carries no identifier", () => {
        const { problem } = matched(
            { sub: { id: "LEIXG-529900T8BM49AURSDO55" } },
            withoutIdentifier,
        );
        expect(problem?.code).toBe("ACCESS_CERTIFICATE_MISMATCH");
        expect(problem?.message).toContain(
            "has no organizationIdentifier or serialNumber",
        );
    });

    it("compares the intermediary in act.sub.id when the relying party acts through one", () => {
        const intermediated = {
            sub: { id: "VATDE-999999999" },
            act: { sub: { id: "LEIXG-529900T8BM49AURSDO55", name: "Example" } },
        };
        expect(matched(intermediated, legalPerson).problem).toBeUndefined();
        expect(
            matched(
                {
                    sub: { id: "LEIXG-529900T8BM49AURSDO55" },
                    act: { sub: { id: "VATDE-1" } },
                },
                legalPerson,
            ).problem?.message,
        ).toContain("act.sub.id");
    });

    it("refuses an intermediated certificate without act.sub.id", () => {
        expect(
            matched(
                { sub: { id: "LEIXG-529900T8BM49AURSDO55" }, act: { sub: {} } },
                legalPerson,
            ).problem?.message,
        ).toContain("no act.sub.id");
    });

    it("refuses an act claim without sub", () => {
        expect(
            matched(
                { sub: { id: "LEIXG-529900T8BM49AURSDO55" }, act: {} },
                legalPerson,
            ).problem?.message,
        ).toContain("no act.sub");
    });

    it("accepts the intermediary as a string act.sub", () => {
        expect(
            matched(
                {
                    sub: { id: "VATDE-1" },
                    act: { sub: "LEIXG-529900T8BM49AURSDO55" },
                },
                legalPerson,
            ).problem,
        ).toBeUndefined();
        expect(
            matched(
                { sub: { id: "VATDE-1" }, act: { sub: "VATDE-2" } },
                legalPerson,
            ).problem?.message,
        ).toContain("its act.sub is 'VATDE-2'");
    });

    it("does not compare certificates without an identifier", () => {
        expect(matched({}, withoutIdentifier).problem).toBeUndefined();
        expect(matched({ sub: "" }, withoutIdentifier).problem).toBeUndefined();
        expect(matched({ sub: {} }, withoutIdentifier).problem).toBeUndefined();
    });

    it("does not compare without an access certificate", () => {
        expect(
            check(
                certificate([["given_name"], ["family_name"]], {
                    sub: { id: "VATDE-1" },
                }),
            ).problem,
        ).toBeUndefined();
    });

    it("reports an access certificate it cannot read", () => {
        expect(
            matched({ sub: { id: "VATDE-1" } }, "not a certificate").problem
                ?.code,
        ).toBe("ACCESS_CERTIFICATE_MISMATCH");
    });
});
