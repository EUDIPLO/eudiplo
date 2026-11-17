import { describe, expect, test } from "vitest";
import {
    claimAt,
    credentialClaims,
    subjectFromPresentation,
    topLevelClaims,
} from "./presented-claims.js";

const KEY = new Uint8Array(32).fill(1);

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
        );
        expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(
            subjectFromPresentation(
                KEY,
                "t",
                "c1",
                subject,
                structuredClone(credentials),
            ),
        ).toBe(first);
        expect(
            subjectFromPresentation(KEY, "t", "c2", subject, credentials),
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
        );
        expect(
            subjectFromPresentation(KEY, "t2", "c", subject, withValue("x")),
        ).not.toBe(base);
        expect(
            subjectFromPresentation(
                new Uint8Array(32).fill(2),
                "t1",
                "c",
                subject,
                withValue("x"),
            ),
        ).not.toBe(base);
        expect(
            subjectFromPresentation(KEY, "t", "c", subject, withValue(42)),
        ).toMatch(/^[A-Za-z0-9_-]{43}$/);
        for (const value of ["", Number.NaN, Number.POSITIVE_INFINITY, true]) {
            expect(
                subjectFromPresentation(
                    KEY,
                    "t",
                    "c",
                    subject,
                    withValue(value),
                ),
            ).toBeUndefined();
        }
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
