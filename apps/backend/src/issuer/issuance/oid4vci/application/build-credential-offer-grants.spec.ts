import {
    authorizationCodeGrantIdentifier,
    preAuthorizedCodeGrantIdentifier,
} from "@openid4vc/oauth2";
import { describe, expect, it } from "vitest";
import { FlowType } from "../dto/offer-request.dto.js";
import { BuildCredentialOfferGrants } from "./build-credential-offer-grants.js";

describe("BuildCredentialOfferGrants", () => {
    const useCase = new BuildCredentialOfferGrants();
    const authorizationServer = { issuer: "https://issuer.example" };

    it("builds an authorization-code grant with issuer state", () => {
        expect(
            useCase.execute({
                flow: FlowType.AUTH_CODE,
                issuerState: "state-1",
                authorizationServer,
            }),
        ).toEqual({
            [authorizationCodeGrantIdentifier]: {
                issuer_state: "state-1",
                authorization_server: authorizationServer,
            },
        });
    });

    it("builds a pre-authorized grant and classifies tx-code input", () => {
        expect(
            useCase.execute({
                flow: FlowType.PRE_AUTH_CODE,
                issuerState: "state-1",
                authorizationCode: "code-1",
                txCode: "0123",
                txCodeDescription: "Wallet PIN",
                authorizationServer,
            }),
        ).toEqual({
            [preAuthorizedCodeGrantIdentifier]: {
                "pre-authorized_code": "code-1",
                tx_code: {
                    input_mode: "numeric",
                    length: 4,
                    description: "Wallet PIN",
                },
                authorization_server: authorizationServer,
            },
        });
    });

    it("preserves text tx-code classification and omitted tx-code", () => {
        expect(
            useCase.execute({
                flow: FlowType.PRE_AUTH_CODE,
                issuerState: "state-1",
                authorizationCode: "code-1",
                txCode: "PIN",
                authorizationServer,
            })[preAuthorizedCodeGrantIdentifier],
        ).toMatchObject({
            tx_code: { input_mode: "text", length: 3 },
        });

        expect(
            useCase.execute({
                flow: FlowType.PRE_AUTH_CODE,
                issuerState: "state-1",
                authorizationCode: "code-1",
                authorizationServer,
            })[preAuthorizedCodeGrantIdentifier],
        ).toMatchObject({ tx_code: undefined });
    });
});
