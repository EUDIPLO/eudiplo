import type { HttpService } from "@nestjs/axios";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { HttpOidcTokenExchanger } from "./http-oidc-token-exchanger.js";

describe("HttpOidcTokenExchanger", () => {
    it("sends the authorization-code exchange form and maps the token response", async () => {
        const post = vi.fn().mockReturnValue(
            of({
                data: {
                    access_token: "access-token",
                    id_token: "id-token",
                },
            }),
        );
        const exchanger = new HttpOidcTokenExchanger({
            post,
        } as unknown as HttpService);

        const result = await exchanger.exchange({
            tokenEndpoint: "https://upstream.example.org/token",
            code: "authorization-code",
            redirectUri: "https://issuer.example.org/callback",
            clientId: "client-id",
            clientSecret: "client-secret",
            codeVerifier: "pkce-verifier",
        });

        expect(result).toEqual({
            accessToken: "access-token",
            idToken: "id-token",
        });
        expect(post).toHaveBeenCalledWith(
            "https://upstream.example.org/token",
            expect.any(String),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            },
        );
        const form = new URLSearchParams(post.mock.calls[0][1]);
        expect(Object.fromEntries(form)).toEqual({
            grant_type: "authorization_code",
            code: "authorization-code",
            redirect_uri: "https://issuer.example.org/callback",
            client_id: "client-id",
            client_secret: "client-secret",
            code_verifier: "pkce-verifier",
        });
    });
});
