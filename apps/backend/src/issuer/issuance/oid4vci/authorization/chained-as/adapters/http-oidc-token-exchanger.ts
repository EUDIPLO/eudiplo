import { HttpService } from "@nestjs/axios";
import { firstValueFrom } from "rxjs";
import type {
    OidcTokenExchangeInput,
    OidcTokenExchangeResult,
    OidcTokenExchanger,
} from "../ports/oidc-token-exchanger.js";

export class HttpOidcTokenExchanger implements OidcTokenExchanger {
    constructor(private readonly http: HttpService) {}

    async exchange(
        input: OidcTokenExchangeInput,
    ): Promise<OidcTokenExchangeResult> {
        const response = await firstValueFrom(
            this.http.post(
                input.tokenEndpoint,
                new URLSearchParams({
                    grant_type: "authorization_code",
                    code: input.code,
                    redirect_uri: input.redirectUri,
                    client_id: input.clientId,
                    client_secret: input.clientSecret || "",
                    code_verifier: input.codeVerifier || "",
                }).toString(),
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                },
            ),
        );

        const tokens = response.data as {
            access_token: string;
            id_token?: string;
        };
        return { accessToken: tokens.access_token, idToken: tokens.id_token };
    }
}
