import { describe, expect, it } from "vitest";
import {
    accessTokenTypeRefusal,
    idTokenClaimRefusal,
    keycloakClientRefusal,
    keycloakTokenTypeRefusal,
} from "./access-token-shape.js";

describe("accessTokenTypeRefusal", () => {
    it.each([
        {},
        { typ: "JWT" },
        { typ: "jwt" },
        { typ: "application/jwt" },
        { typ: "at+jwt" },
        { typ: "AT+JWT" },
        { typ: "application/at+jwt" },
    ])("accepts the header %j", (header) => {
        expect(accessTokenTypeRefusal(header)).toBeUndefined();
    });

    it.each([
        { typ: "logout+jwt" },
        { typ: "dpop+jwt" },
        { typ: "id_token+jwt" },
        { typ: "" },
        { typ: 1 },
    ])("refuses the header %j", (header) => {
        expect(accessTokenTypeRefusal(header)).toMatch(/^Not an access token/);
    });
});

describe("idTokenClaimRefusal", () => {
    it("accepts an access token, also one with nonce, as Authentik issues them", () => {
        expect(
            idTokenClaimRefusal({
                sub: "person",
                aud: "eudiplo",
                nonce: "n",
                scope: "openid",
            }),
        ).toBeUndefined();
    });

    it.each(["at_hash", "c_hash", "s_hash"])(
        "refuses a token with %s",
        (claim) => {
            expect(idTokenClaimRefusal({ sub: "person", [claim]: "h" })).toBe(
                `Not an access token: the token carries ${claim}, which only ID tokens carry; send the access token`,
            );
        },
    );

    it("ignores inherited properties", () => {
        expect(
            idTokenClaimRefusal(Object.create({ at_hash: "h" }) as object),
        ).toBeUndefined();
    });
});

describe("keycloakTokenTypeRefusal", () => {
    it.each([{}, { typ: "Bearer" }, { typ: "bearer" }])(
        "accepts the payload %j",
        (payload) => {
            expect(keycloakTokenTypeRefusal(payload)).toBeUndefined();
        },
    );

    it.each([
        { typ: "ID" },
        { typ: "Refresh" },
        { typ: "Offline" },
        { typ: "Logout" },
        // Bound to a DPoP key, whose proof the management API does not check.
        { typ: "DPoP" },
        { typ: "" },
        { typ: null },
        { typ: ["Bearer"] },
    ])("refuses the payload %j", (payload) => {
        expect(keycloakTokenTypeRefusal(payload)).toBe(
            "Not an access token: its typ claim is not Bearer, as on Keycloak access tokens; send the access token",
        );
    });
});

describe("keycloakClientRefusal", () => {
    const own = ["eudiplo-ui", undefined];
    const refusal =
        "This token was issued to a client of the realm that EUDIPLO does not manage";

    it("accepts EUDIPLO's own clients and the managed client named", () => {
        expect(keycloakClientRefusal("eudiplo-ui", own, undefined)).toBe(
            undefined,
        );
        expect(keycloakClientRefusal("shop", own, "shop")).toBe(undefined);
    });

    it("refuses other clients of the realm", () => {
        expect(keycloakClientRefusal("other-app", own, undefined)).toBe(
            refusal,
        );
    });

    it("refuses a managed client that the token does not name", () => {
        // Found by sub, as the token has no azp or client_id.
        expect(keycloakClientRefusal(undefined, own, "user-uuid")).toBe(
            refusal,
        );
    });

    it.each([undefined, "", ["eudiplo-ui"], 42])(
        "refuses the authorized party %j",
        (authorizedParty) => {
            expect(keycloakClientRefusal(authorizedParty, own, "")).toBe(
                refusal,
            );
            expect(keycloakClientRefusal(authorizedParty, own, undefined)).toBe(
                refusal,
            );
        },
    );
});
