import { describe, expect, it } from "vitest";
import {
    attestationMaintenanceEnd,
    attestationStatusReferences,
} from "./attestation-status-claims.js";
import { MalformedStatusReferenceError } from "./status-list-reference.js";

describe("attestationMaintenanceEnd", () => {
    it("reads client_status.exp of a wallet attestation and key_storage_status.exp of a key attestation", () => {
        expect(
            attestationMaintenanceEnd(
                { client_status: { exp: 1_900_000_000 } },
                "wallet",
            ),
        ).toBe(1_900_000_000);
        expect(
            attestationMaintenanceEnd(
                { key_storage_status: { exp: 1_900_000_001 } },
                "key",
            ),
        ).toBe(1_900_000_001);
    });

    it("ignores the token's own exp and the claim of the other kind", () => {
        expect(
            attestationMaintenanceEnd(
                { exp: 1, key_storage_status: { exp: 2 } },
                "wallet",
            ),
        ).toBeUndefined();
    });

    it.each([
        ["no TS3 claim", {}],
        ["a TS3 claim without exp", { client_status: { status: {} } }],
    ])("is undefined for %s", (_case, payload) => {
        expect(attestationMaintenanceEnd(payload, "wallet")).toBeUndefined();
    });

    it.each([
        ["a string", "1900000000"],
        ["negative", -1],
        ["null", null],
        ["after the year 9999", 253_402_300_800],
    ])("throws for an exp that is %s", (_case, exp) => {
        expect(() =>
            attestationMaintenanceEnd({ client_status: { exp } }, "wallet"),
        ).toThrow(MalformedStatusReferenceError);
    });
});

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
