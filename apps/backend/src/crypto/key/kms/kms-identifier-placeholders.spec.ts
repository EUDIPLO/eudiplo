import { describe, expect, it } from "vitest";
import { findKmsIdentifierPlaceholderIssues } from "./kms-identifier-placeholders.js";

describe("findKmsIdentifierPlaceholderIssues", () => {
    it("finds placeholders in defaultProvider and provider ids, in every form", () => {
        const issues = findKmsIdentifierPlaceholderIssues({
            defaultProvider: "${DEFAULT_KMS}",
            providers: [
                { id: "db", type: "db" },
                { id: "x${MASTER_SECRET}y", type: "db" },
                { id: "${A:fallback}", type: "db" },
            ],
        });

        expect(issues.map((issue) => issue.path)).toEqual([
            ["defaultProvider"],
            ["providers", 1, "id"],
            ["providers", 2, "id"],
        ]);
        // The message names the variables, as the other refusals do.
        expect(issues.map((issue) => issue.message)).toEqual([
            expect.stringContaining("defaultProvider names ${DEFAULT_KMS}:"),
            expect.stringContaining("providers.1.id names ${MASTER_SECRET}:"),
            expect.stringContaining("providers.2.id names ${A}:"),
        ]);
    });

    it("leaves placeholders in other settings to the variable rules", () => {
        expect(
            findKmsIdentifierPlaceholderIssues({
                defaultProvider: "own",
                providers: [
                    {
                        id: "own",
                        type: "vault",
                        vaultUrl: "${TENANT_VAULT_URL}",
                        vaultToken: "${TENANT_TOKEN}",
                        description: "${id}",
                    },
                ],
            }),
        ).toEqual([]);
    });

    it.each([
        null,
        undefined,
        "text",
        [],
        { providers: "x" },
        { providers: [null, 1] },
    ])("finds nothing in %j, which the schema reports", (config) => {
        expect(findKmsIdentifierPlaceholderIssues(config)).toEqual([]);
    });
});
