import { describe, expect, it } from "vitest";
import { ClassifyAuthorizationServerToken } from "./classify-authorization-server-token.js";

describe("ClassifyAuthorizationServerToken", () => {
    const useCase = new ClassifyAuthorizationServerToken();
    const managed = new Set(["https://managed.example"]);
    const input = {
        tokenIssuer: "",
        localIssuer: "https://issuer.example",
        chainedIssuer: "https://issuer.example/chained-as",
        hasChainedAuthorizationServer: true,
        managedAuthorizationServerIssuers: managed,
    };

    it("classifies local authorization server tokens first", () => {
        expect(
            useCase.execute({ ...input, tokenIssuer: input.localIssuer }),
        ).toBe("local");
    });

    it("classifies configured chained and managed issuer tokens", () => {
        expect(
            useCase.execute({ ...input, tokenIssuer: input.chainedIssuer }),
        ).toBe("chained");
        expect(
            useCase.execute({
                ...input,
                tokenIssuer: "https://managed.example",
            }),
        ).toBe("chained");
    });

    it("treats the chained issuer as external when chained authorization is disabled", () => {
        expect(
            useCase.execute({
                ...input,
                tokenIssuer: input.chainedIssuer,
                hasChainedAuthorizationServer: false,
            }),
        ).toBe("external");
    });

    it("classifies other issuers as external", () => {
        expect(
            useCase.execute({ ...input, tokenIssuer: "https://other.example" }),
        ).toBe("external");
    });
});
