import { describe, expect, it } from "vitest";
import {
    isUuidPrefix,
    parseSessionSearch,
    uuidPrefixRange,
} from "./session-search.js";

const SESSION_ID = "3f2a9c1e-7b4d-4e2f-9a1b-0c3d5e7f9a1b";
const NONCE = "11111111-1111-4111-8111-111111111111";

describe("isUuidPrefix", () => {
    it.each(["3", "3F2A", "3f2a9c1e-", "3f2a9c1e-7b4d", SESSION_ID])(
        "accepts %s",
        (value) => expect(isUuidPrefix(value)).toBe(true),
    );

    it.each(["", "3g", "3f2a9c1e7", `${SESSION_ID}0`, "order-4711"])(
        "rejects %s",
        (value) => expect(isUuidPrefix(value)).toBe(false),
    );
});

describe("uuidPrefixRange", () => {
    it("spans every UUID starting with the prefix", () => {
        expect(uuidPrefixRange("3F2A")).toEqual([
            "3f2a0000-0000-0000-0000-000000000000",
            "3f2affff-ffff-ffff-ffff-ffffffffffff",
        ]);
        expect(uuidPrefixRange(SESSION_ID)).toEqual([SESSION_ID, SESSION_ID]);
    });
});

describe("parseSessionSearch", () => {
    it("matches a plain term against every identifier", () => {
        expect(parseSessionSearch(" order-4711 ")).toEqual({
            walletNonce: "order-4711",
            authorizationCode: "order-4711",
            reference: "order-4711",
        });
        expect(parseSessionSearch("3F2A")).toEqual({
            idPrefix: "3f2a",
            walletNonce: "3F2A",
            authorizationCode: "3F2A",
            reference: "3F2A",
        });
    });

    it("takes the session id from a credential offer link", () => {
        const offerUri = `https://issuer.example/issuers/tenant/vci/credential-offers/${SESSION_ID}`;
        expect(
            parseSessionSearch(
                `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(offerUri)}`,
            ),
        ).toEqual({ idPrefix: SESSION_ID });
        expect(parseSessionSearch(offerUri)).toEqual({ idPrefix: SESSION_ID });
    });

    it("takes the issuer state or pre-authorized code from an offer by value", () => {
        const byValue = (grants: object) =>
            `openid-credential-offer://?credential_offer=${encodeURIComponent(
                JSON.stringify({
                    credential_issuer: "https://issuer.example",
                    credential_configuration_ids: ["pid"],
                    grants,
                }),
            )}`;
        expect(
            parseSessionSearch(
                byValue({ authorization_code: { issuer_state: SESSION_ID } }),
            ),
        ).toEqual({ idPrefix: SESSION_ID });
        expect(
            parseSessionSearch(
                byValue({
                    "urn:ietf:params:oauth:grant-type:pre-authorized_code": {
                        "pre-authorized_code": "code-1",
                    },
                }),
            ),
        ).toEqual({ authorizationCode: "code-1" });
    });

    it("takes the wallet nonce from an OID4VP request link", () => {
        for (const path of ["request", "request/no-redirect"]) {
            const requestUri = `https://verifier.example/presentations/${NONCE}/oid4vp/${path}`;
            expect(
                parseSessionSearch(
                    `openid4vp://?client_id=x509_hash%3Aabc&request_uri=${encodeURIComponent(requestUri)}`,
                ),
            ).toEqual({ walletNonce: NONCE });
        }
    });

    it("matches nothing for a link with a malformed session id", () => {
        expect(
            parseSessionSearch(
                "https://issuer.example/vci/credential-offers/3f2a",
            ),
        ).toEqual({ idPrefix: undefined });
    });

    it("treats an unrecognised link or invalid offer as a plain term", () => {
        const link = "https://example.com/somewhere";
        expect(parseSessionSearch(link)).toMatchObject({ reference: link });
        const invalid = "openid-credential-offer://?credential_offer=%7B";
        expect(parseSessionSearch(invalid)).toEqual({
            walletNonce: invalid,
            authorizationCode: invalid,
            reference: invalid,
        });
    });
});
