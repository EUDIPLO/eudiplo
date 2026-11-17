import { describe, expect, test } from "vitest";
import { OidcError } from "./domain/oidc-error.js";
import {
    clientCredentials,
    readCookie,
    signInCookieName,
} from "./oidc-http.util.js";

const basic = (value: string) =>
    `Basic ${Buffer.from(value).toString("base64")}`;

describe("clientCredentials", () => {
    test("decodes form-encoded Basic credentials", () => {
        expect(clientCredentials(basic("my%20client:p%3Ass+word"), {})).toEqual(
            {
                clientId: "my client",
                clientSecret: "p:ss word",
                method: "basic",
            },
        );
    });

    test("reads client_secret_post", () => {
        expect(
            clientCredentials(undefined, {
                client_id: "c",
                client_secret: "s",
            }),
        ).toEqual({ clientId: "c", clientSecret: "s", method: "post" });
    });

    test("refuses two authentication methods at once", () => {
        expect(() =>
            clientCredentials(basic("c:s"), { client_secret: "s" }),
        ).toThrow(OidcError);
    });

    test("refuses a body client_id that differs from Basic", () => {
        expect(() =>
            clientCredentials(basic("c:s"), { client_id: "other" }),
        ).toThrow("does not match");
    });

    test("malformed Basic credentials fail client authentication", () => {
        try {
            clientCredentials(basic("no-separator"), {});
            throw new Error("expected an error");
        } catch (error) {
            expect(error).toMatchObject({
                code: "invalid_client",
                clientAuthenticationFailed: true,
            });
        }
    });
});

describe("readCookie", () => {
    test("finds the sign-in cookie among others", () => {
        const name = signInCookieName("1b4e28ba-2fa1-11d2-883f-0016d3cca427");
        expect(readCookie(`a=1; ${name}=secret%2Bvalue; b=2`, name)).toBe(
            "secret+value",
        );
        expect(readCookie("a=1", name)).toBeUndefined();
        expect(readCookie(undefined, name)).toBeUndefined();
    });

    test("a sign-in ID cannot inject cookie syntax into the name", () => {
        expect(signInCookieName("x; Path=/")).toBe("eudiplo_oidc_xPath");
    });
});
