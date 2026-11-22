import { describe, expect, it } from "vitest";
import { attestationStatusReferences } from "./attestation-status-claims.js";
import { MalformedStatusReferenceError } from "./status-list-reference.js";

const TS3 = { uri: "https://wp.example/wia", idx: 1337 };
const TOP = { uri: "https://wp.example/token", idx: 7 };

describe("attestationStatusReferences", () => {
    it("reads client_status.status of a wallet attestation", () => {
        expect(
            attestationStatusReferences(
                {
                    client_status: {
                        status: { status_list: TS3 },
                        exp: 2_000_000_000,
                    },
                },
                "wallet",
            ),
        ).toEqual([TS3]);
    });

    it("reads key_storage_status.status of a key attestation", () => {
        expect(
            attestationStatusReferences(
                { key_storage_status: { status: { status_list: TS3 } } },
                "key",
            ),
        ).toEqual([TS3]);
    });

    it("reads the claim of the other kind as nothing", () => {
        expect(
            attestationStatusReferences(
                { key_storage_status: { status: { status_list: TS3 } } },
                "wallet",
            ),
        ).toEqual([]);
        expect(
            attestationStatusReferences(
                { client_status: { status: { status_list: TS3 } } },
                "key",
            ),
        ).toEqual([]);
    });

    it("reads the top-level status of an attestation in the earlier format", () => {
        expect(
            attestationStatusReferences(
                { status: { status_list: TOP } },
                "key",
            ),
        ).toEqual([TOP]);
    });

    it("gives both entries, the TS3 one first", () => {
        expect(
            attestationStatusReferences(
                {
                    status: { status_list: TOP },
                    client_status: { status: { status_list: TS3 } },
                },
                "wallet",
            ),
        ).toEqual([TS3, TOP]);
    });

    it("gives an entry both claims name once", () => {
        expect(
            attestationStatusReferences(
                {
                    status: { status_list: TS3 },
                    client_status: { status: { status_list: TS3 } },
                },
                "wallet",
            ),
        ).toEqual([TS3]);
    });

    it.each([
        ["without status", { client_status: { exp: 2_000_000_000 } }],
        [
            "whose status names another mechanism",
            { client_status: { status: { identifier_list: { id: "1" } } } },
        ],
    ])("reads a TS3 claim %s as no reference", (_case, payload) => {
        expect(attestationStatusReferences(payload, "wallet")).toEqual([]);
    });

    it.each([
        ["a string", { client_status: "revoked" }],
        ["null", { client_status: null }],
        ["an array", { client_status: [] }],
        ["with an empty status", { client_status: { status: {} } }],
        [
            "with a relative uri",
            {
                client_status: {
                    status: { status_list: { uri: "/s", idx: 1 } },
                },
            },
        ],
    ])("throws for a client_status claim that is %s", (_case, payload) => {
        expect(() => attestationStatusReferences(payload, "wallet")).toThrow(
            MalformedStatusReferenceError,
        );
    });

    it("names the TS3 claim in the error", () => {
        expect(() =>
            attestationStatusReferences(
                { key_storage_status: { status: { status_list: null } } },
                "key",
            ),
        ).toThrow(/^key_storage_status\.status: /);
    });

    it("skips malformed claims when asked, and keeps the others", () => {
        expect(
            attestationStatusReferences(
                {
                    status: "bad",
                    key_storage_status: { status: { status_list: TS3 } },
                },
                "key",
                { skipMalformed: true },
            ),
        ).toEqual([TS3]);
        expect(
            attestationStatusReferences(
                { status: { status_list: TOP }, key_storage_status: 1 },
                "key",
                { skipMalformed: true },
            ),
        ).toEqual([TOP]);
    });
});
