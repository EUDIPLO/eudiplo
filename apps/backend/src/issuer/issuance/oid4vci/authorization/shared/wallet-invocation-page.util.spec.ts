import { describe, expect, it } from "vitest";
import { renderWalletInvocationPage } from "./wallet-invocation-page.util.js";

describe("renderWalletInvocationPage", () => {
    it("links to the wallet invocation URL with query separators escaped", () => {
        const html = renderWalletInvocationPage(
            "openid4vp://?client_id=x509_hash%3Aabc&request_uri=https%3A%2F%2Fissuer.example%2Frequest",
        );

        expect(html).toContain(
            'href="openid4vp://?client_id=x509_hash%3Aabc&amp;request_uri=https%3A%2F%2Fissuer.example%2Frequest"',
        );
    });

    it("cannot be broken out of the href attribute", () => {
        const html = renderWalletInvocationPage(
            'openid4vp://?x="><script>alert(1)</script>',
        );

        expect(html).not.toContain("<script>");
        expect(html).toContain(
            'href="openid4vp://?x=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"',
        );
    });
});
