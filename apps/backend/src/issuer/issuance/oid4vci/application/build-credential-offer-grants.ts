import {
    authorizationCodeGrantIdentifier,
    preAuthorizedCodeGrantIdentifier,
} from "@openid4vc/oauth2";
import type {
    CredentialOfferAuthorizationCodeGrant,
    CredentialOfferPreAuthorizedCodeGrant,
} from "@openid4vc/openid4vci";
import type { CredentialOfferGrants } from "../domain/credential-offer-grants.js";

type CredentialOfferFlow = "authorization_code" | "pre_authorized_code";

export interface BuildCredentialOfferGrantsInput {
    flow: CredentialOfferFlow;
    issuerState: string;
    authorizationCode?: string;
    txCode?: string;
    txCodeDescription?: string;
    authorizationServer: unknown;
}

export class BuildCredentialOfferGrants {
    execute(input: BuildCredentialOfferGrantsInput): CredentialOfferGrants {
        if (input.flow === "pre_authorized_code") {
            if (!input.authorizationCode) {
                throw new Error(
                    "Pre-authorized credential offers require an authorization code",
                );
            }

            return {
                [preAuthorizedCodeGrantIdentifier]: {
                    "pre-authorized_code": input.authorizationCode,
                    tx_code: input.txCode
                        ? {
                              input_mode: Number(input.txCode)
                                  ? "numeric"
                                  : "text",
                              length: input.txCode.length,
                              description: input.txCodeDescription,
                          }
                        : undefined,
                    authorization_server: input.authorizationServer,
                } as CredentialOfferPreAuthorizedCodeGrant,
            };
        }

        return {
            [authorizationCodeGrantIdentifier]: {
                issuer_state: input.issuerState,
                authorization_server: input.authorizationServer,
            } as CredentialOfferAuthorizationCodeGrant,
        };
    }
}
