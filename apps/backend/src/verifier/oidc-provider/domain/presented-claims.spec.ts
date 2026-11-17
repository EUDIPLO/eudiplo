import { describe, expect, test } from "vitest";
import {
    claimAt,
    credentialClaims,
    subjectFromPresentation,
    topLevelClaims,
} from "./presented-claims.js";

const KEY = new Uint8Array(32).fill(1);
const ISSUERS = { pid: "https://issuer.example" };

const credentials = [
    { id: "other", values: [{ given_name: "Eve" }] },
    {
        id: "pid",
        values: [
            {
                vct: "urn:eudi:pid:1",
                iss: "https://issuer.example",
                given_name: "Ada",
                personal_administrative_number: "AB-123",
                address: { country: "DE" },
            },
        ],
    },
];

describe("presented claims", () => {
    test("reads the first values of the named credential", () => {
        expect(credentialClaims(credentials, "pid")?.given_name).toBe("Ada");
        expect(credentialClaims(credentials, "missing")).toBeUndefined();
        expect(credentialClaims(undefined, "pid")).toBeUndefined();
    });

    test("follows a dotted path", () => {
        const claims = credentialClaims(credentials, "pid");
        expect(claimAt(claims, "address.country")).toBe("DE");
        expect(claimAt(claims, "address.city")).toBeUndefined();
        expect(claimAt(claims, "given_name.x")).toBeUndefined();
        expect(claimAt(claims, "__proto__")).toBeUndefined();
        expect(claimAt(claims, "constructor.name")).toBeUndefined();
    });

    test("derives a subject that is stable per client and differs between clients", () => {
        const subject = {
            credentialId: "pid",
            claim: "personal_administrative_number",
        };
        const first = subjectFromPresentation(
            KEY,
            "t",
            "c1",
            subject,
            credentials,
            ISSUERS,
        );
        expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(
            subjectFromPresentation(
                KEY,
                "t",
                "c1",
                subject,
                structuredClone(credentials),
                ISSUERS,
            ),
        ).toBe(first);
        expect(
            subjectFromPresentation(
                KEY,
                "t",
                "c2",
                subject,
                credentials,
                ISSUERS,
            ),
        ).not.toBe(first);
        expect(first).not.toContain("AB-123");
    });

    test("has no subject for a missing or non-scalar claim", () => {
        for (const claim of ["missing", "address"]) {
            expect(
                subjectFromPresentation(
                    KEY,
                    "t",
                    "c",
                    { credentialId: "pid", claim },
                    credentials,
                    ISSUERS,
                ),
            ).toBeUndefined();
        }
    });

    test("the subject depends on tenant and key, and accepts only non-empty strings and finite numbers", () => {
        const subject = { credentialId: "pid", claim: "value" };
        const withValue = (value: unknown) => [
            { id: "pid", values: [{ value }] },
        ];
        const base = subjectFromPresentation(
            KEY,
            "t1",
            "c",
            subject,
            withValue("x"),
            ISSUERS,
        );
        expect(
            subjectFromPresentation(
                KEY,
                "t2",
                "c",
                subject,
                withValue("x"),
                ISSUERS,
            ),
        ).not.toBe(base);
        expect(
            subjectFromPresentation(
                new Uint8Array(32).fill(2),
                "t1",
                "c",
                subject,
                withValue("x"),
                ISSUERS,
            ),
        ).not.toBe(base);
        expect(
            subjectFromPresentation(
                KEY,
                "t",
                "c",
                subject,
                withValue(42),
                ISSUERS,
            ),
        ).toMatch(/^[A-Za-z0-9_-]{43}$/);
        for (const value of ["", Number.NaN, Number.POSITIVE_INFINITY, true]) {
            expect(
                subjectFromPresentation(
                    KEY,
                    "t",
                    "c",
                    subject,
                    withValue(value),
                    ISSUERS,
                ),
            ).toBeUndefined();
        }
    });

    test("the issuer is part of the subject, and an unknown issuer gives none", () => {
        const subject = {
            credentialId: "pid",
            claim: "personal_administrative_number",
        };
        const one = subjectFromPresentation(
            KEY,
            "t",
            "c",
            subject,
            credentials,
            {
                pid: "issuer-a",
            },
        );
        const other = subjectFromPresentation(
            KEY,
            "t",
            "c",
            subject,
            credentials,
            { pid: "issuer-b" },
        );
        expect(one).toBeDefined();
        expect(other).not.toBe(one);
        expect(
            subjectFromPresentation(KEY, "t", "c", subject, credentials, {}),
        ).toBeUndefined();
    });

    test("puts claims at the top level without reserved names", () => {
        expect(topLevelClaims(credentials, "pid")).toEqual({
            given_name: "Ada",
            personal_administrative_number: "AB-123",
            address: { country: "DE" },
        });
        expect(topLevelClaims(credentials, "missing")).toEqual({});
    });
});
