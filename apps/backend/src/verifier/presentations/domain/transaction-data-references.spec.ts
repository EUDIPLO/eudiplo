import { describe, expect, it } from "vitest";
import { uncheckableTransactionData } from "./transaction-data-references.js";

const credentials = [
    { id: "pid", format: "dc+sd-jwt" },
    { id: "card", format: "dc+sd-jwt" },
    { id: "mdl", format: "mso_mdoc" },
];

describe("uncheckableTransactionData", () => {
    it("accepts no transaction data", () => {
        expect(uncheckableTransactionData(undefined, credentials)).toBe(
            undefined,
        );
        expect(uncheckableTransactionData(null, credentials)).toBe(undefined);
        expect(uncheckableTransactionData([], [])).toBe(undefined);
    });

    it("accepts entries that reference only SD-JWT VC queries", () => {
        expect(
            uncheckableTransactionData(
                [
                    { credential_ids: ["pid"] },
                    { credential_ids: ["card", "pid"] },
                ],
                credentials,
            ),
        ).toBe(undefined);
    });

    it("rejects an entry naming no credential query", () => {
        expect(
            uncheckableTransactionData([{ credential_ids: [] }], credentials),
        ).toBe("transaction_data[0].credential_ids names no credential query");
    });

    it("rejects ids that are not in the DCQL query, even next to a known one", () => {
        expect(
            uncheckableTransactionData(
                [{ credential_ids: ["pid", "iban", "bic"] }],
                credentials,
            ),
        ).toBe(
            "transaction_data[0].credential_ids names ids that are not in the DCQL query: iban, bic",
        );
    });

    it.each([
        ["only mdoc queries", ["mdl"]],
        ["an mdoc query next to an SD-JWT VC query", ["pid", "mdl"]],
    ])("rejects an entry that references %s", (_, credentialIds) => {
        expect(
            uncheckableTransactionData(
                [{ credential_ids: credentialIds }],
                credentials,
            ),
        ).toBe(
            "transaction_data[0].credential_ids names credential queries that are not dc+sd-jwt: mdl; EUDIPLO checks transaction data only in SD-JWT VC presentations",
        );
    });

    it("names every entry that breaks a rule", () => {
        expect(
            uncheckableTransactionData(
                [
                    { credential_ids: ["mdl"] },
                    { credential_ids: ["pid"] },
                    { credential_ids: ["x"] },
                ],
                credentials,
            ),
        ).toBe(
            "transaction_data[0].credential_ids names credential queries that are not dc+sd-jwt: mdl; EUDIPLO checks transaction data only in SD-JWT VC presentations; transaction_data[2].credential_ids names ids that are not in the DCQL query: x",
        );
    });
});
