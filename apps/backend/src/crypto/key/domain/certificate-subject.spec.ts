import { describe, expect, it } from "vitest";
import {
    InvalidSubjectError,
    MAX_SUBJECT_LENGTH,
    parseSubject,
} from "./certificate-subject.js";

describe("parseSubject", () => {
    it.each([undefined, "", "   "])(
        "leaves %j to the default subject",
        (subject) => {
            expect(parseSubject(subject)).toBeUndefined();
        },
    );

    it("reads a distinguished name", () => {
        expect(parseSubject(" C=DE, O=Example, CN=Verifier ")?.toString()).toBe(
            "C=DE, O=Example, CN=Verifier",
        );
    });

    it("accepts a subject of the maximum length", () => {
        expect(
            parseSubject(`CN=${"a".repeat(MAX_SUBJECT_LENGTH - 3)}`),
        ).toBeDefined();
    });

    it.each(["not a distinguished name", "CN=", "CN=Verifier, O=", "foo=bar"])(
        "refuses %j",
        (subject) => {
            expect(() => parseSubject(subject)).toThrow(
                /is not a distinguished name with a value for each attribute/,
            );
        },
    );

    it("refuses a subject given twice", () => {
        expect(() => parseSubject(["CN=a", "CN=b"])).toThrow(
            "Give the subject once, as one string.",
        );
    });

    it("refuses a subject longer than the limit before parsing it", () => {
        expect(() =>
            parseSubject(`CN=${"a".repeat(MAX_SUBJECT_LENGTH)}`),
        ).toThrow(
            new InvalidSubjectError(
                `The subject must not be longer than ${MAX_SUBJECT_LENGTH} characters.`,
            ),
        );
    });
});
