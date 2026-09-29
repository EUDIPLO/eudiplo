import { describe, expect, it } from "vitest";
import {
    assertClaimsMatchConfiguration,
    InvalidCredentialClaims,
} from "./credential-claims-validation.js";

const configuration = {
    id: "citizen",
    fields: [
        {
            path: ["town"],
            type: "string",
            mandatory: true,
            defaultValue: "BERLIN",
        },
        {
            path: ["address"],
            type: "object",
            children: [{ path: ["street"], type: "string", mandatory: true }],
        },
    ],
};

describe("assertClaimsMatchConfiguration", () => {
    it("accepts claims that match the configuration", () => {
        expect(() =>
            assertClaimsMatchConfiguration(configuration, {
                town: "Köln",
                address: { street: "Main St" },
            }),
        ).not.toThrow();
    });

    it.each([
        ["a wrong type", { town: 5 }, "/town: must be string"],
        ["a missing required claim", {}, "/town: missing required claim"],
        [
            "an unexpected claim",
            { town: "Köln", nickname: "x" },
            "/nickname: unexpected claim",
        ],
        [
            "an invalid nested claim",
            { town: "Köln", address: {} },
            "/address/street: missing required claim",
        ],
    ])("rejects %s", (_case, claims, message) => {
        expect(() =>
            assertClaimsMatchConfiguration(configuration, claims),
        ).toThrow(message);
    });

    it("names claim paths without exposing claim values", () => {
        try {
            assertClaimsMatchConfiguration(configuration, {
                town: 42,
                secret: "Kölsche Geheimnis",
            });
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(InvalidCredentialClaims);
            expect((error as Error).message).toContain("/secret");
            expect((error as Error).message).not.toContain("Kölsche");
            expect((error as Error).message).not.toContain("42");
        }
    });

    it("does not validate configurations without fields", () => {
        expect(() =>
            assertClaimsMatchConfiguration(
                { id: "free", fields: [] },
                { anything: true },
            ),
        ).not.toThrow();
    });
});
