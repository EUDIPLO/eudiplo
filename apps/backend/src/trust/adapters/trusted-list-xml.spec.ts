import { beforeAll, describe, expect, it } from "vitest";
import { generateSelfSignedCertificate } from "../../../test/issuance/attestation-trust-helpers.js";
import {
    buildSignedTrustedList,
    TSL_TYPE,
} from "../../../test/trust/trusted-list.fixture.js";
import { readTrustedListXml } from "./trusted-list-xml.js";

describe("readTrustedListXml", () => {
    let signer: Awaited<ReturnType<typeof generateSelfSignedCertificate>>;
    let lotl: string;

    beforeAll(async () => {
        signer = await generateSelfSignedCertificate();
        lotl = await buildSignedTrustedList(
            {
                tslType: TSL_TYPE.EUlistofthelists,
                pointers: [
                    {
                        location: "https://tl.example/de.xml",
                        signers: [signer.certificate],
                    },
                    {
                        location: "https://tl.example/de.pdf",
                        signers: [signer.certificate],
                        mimeType: "application/pdf",
                    },
                ],
            },
            signer,
        );
    });

    it("reads the media type of each pointer from a list signed as a whole", () => {
        expect(readTrustedListXml(lotl).pointerMediaTypes).toEqual(
            new Map([
                ["https://tl.example/de.xml", "application/vnd.etsi.tsl+xml"],
                ["https://tl.example/de.pdf", "application/pdf"],
            ]),
        );
    });

    it("accepts a signature that references the list by the Id of its root", async () => {
        const xml = await buildSignedTrustedList({}, signer, true);
        expect(xml).toMatch(/URI="#tsl-/);

        expect(() => readTrustedListXml(xml)).not.toThrow();
    });

    // A transform runs when its reference is checked, before the signature.
    it.each([
        "http://www.w3.org/TR/1999/REC-xpath-19991116",
        "http://www.w3.org/2002/06/xmldsig-filter2",
        "http://www.w3.org/TR/1999/REC-xslt-19991116",
        "http://www.w3.org/2000/09/xmldsig#base64",
    ])("refuses the transform %s", (algorithm) => {
        const xml = lotl.replace(
            '<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>',
            `<ds:Transform Algorithm="${algorithm}"><ds:XPath>count(//*) &gt; 0</ds:XPath></ds:Transform>`,
        );
        expect(xml).not.toBe(lotl);

        expect(() => readTrustedListXml(xml)).toThrow(
            `its signature uses the transform "${algorithm}"`,
        );
    });

    it("refuses another canonicalization of SignedInfo", () => {
        const xml = lotl.replace(
            /<ds:CanonicalizationMethod Algorithm="[^"]*"/,
            '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"',
        );

        expect(() => readTrustedListXml(xml)).toThrow(
            "its signature uses the canonicalization",
        );
    });

    // A signature over another element could be wrapped into a new root
    // with other content (XML Signature Best Practices, section 2.3).
    it("refuses a signature without reference to the whole list", () => {
        const xml = lotl.replace('URI=""', 'URI="#elsewhere"');

        expect(() => readTrustedListXml(xml)).toThrow(
            'its signature references "#elsewhere", which is neither the whole list nor part of its signature',
        );
    });

    it("refuses a reference by Id when another element has the root's Id", async () => {
        const xml = await buildSignedTrustedList({}, signer, true);
        const rootId = /Id="(tsl-[^"]+)"/.exec(xml)![1];
        const wrapped = xml.replace(
            "<SchemeInformation>",
            `<SchemeInformation><x:Copy xmlns:x="urn:x" Id="${rootId}"/>`,
        );

        expect(() => readTrustedListXml(wrapped)).toThrow(
            `its signature references "#${rootId}"`,
        );
    });

    it("refuses a signature whose only reference is to its signed properties", () => {
        const xml = lotl.replace(
            /<ds:Reference[^>]*URI=""[^>]*>[\s\S]*?<\/ds:Reference>/,
            "",
        );
        expect(xml).not.toBe(lotl);

        expect(() => readTrustedListXml(xml)).toThrow(
            "its signature does not reference the whole list",
        );
    });

    it("refuses a signed-properties reference whose Id another element has too", () => {
        const signedPropertiesId = /<xades:SignedProperties Id="([^"]+)"/.exec(
            lotl,
        )![1];
        const xml = lotl.replace(
            "<SchemeInformation>",
            `<SchemeInformation><x:Copy xmlns:x="urn:x" Id="${signedPropertiesId}"/>`,
        );

        expect(() => readTrustedListXml(xml)).toThrow(
            "which is neither the whole list nor part of its signature",
        );
    });

    it("refuses a reference to an element outside the signature", () => {
        const xml = lotl
            .replace(
                "<SchemeInformation>",
                '<SchemeInformation Id="scheme-information">',
            )
            .replace(
                /URI="#xades-[^"]+" Type/,
                'URI="#scheme-information" Type',
            );
        expect(xml).toContain('URI="#scheme-information"');

        expect(() => readTrustedListXml(xml)).toThrow(
            'its signature references "#scheme-information", which is neither the whole list nor part of its signature',
        );
    });

    // Annex B.1.0 rule 4: other references, for example to the KeyInfo.
    it("accepts another reference to an element inside the signature", () => {
        const signatureId = /<ds:Signature Id="([^"]+)"/.exec(lotl)![1];
        const xml = lotl.replace(
            /URI="#xades-[^"]+" Type="[^"]+"/,
            `URI="#${signatureId}"`,
        );
        expect(xml).toContain(`URI="#${signatureId}"`);

        expect(() => readTrustedListXml(xml)).not.toThrow();
    });

    // Another SignedInfo, outside the signature, would make an unsigned
    // reference to the list count.
    it("refuses a list with another SignedInfo than its signature's", () => {
        const xml = lotl.replace(
            "<SchemeInformation>",
            '<SchemeInformation><ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:Reference URI=""/></ds:SignedInfo>',
        );

        expect(() => readTrustedListXml(xml)).toThrow(
            "it does not have exactly one signature, with one SignedInfo, as a child of its root",
        );
    });

    it("refuses a signature with more than 8 references", () => {
        const reference =
            /<ds:Reference[^>]*URI=""[^>]*>[\s\S]*?<\/ds:Reference>/.exec(
                lotl,
            )![0];
        const xml = lotl.replace(reference, reference.repeat(9));

        expect(() => readTrustedListXml(xml)).toThrow(
            "its signature has 10 references; at most 8 are accepted",
        );
    });

    it("refuses a list that holds another TrustServiceStatusList", () => {
        const xml = lotl.replace(
            "<SchemeInformation>",
            '<x:Wrapped xmlns:x="urn:x"><TrustServiceStatusList/></x:Wrapped><SchemeInformation>',
        );

        expect(() => readTrustedListXml(xml)).toThrow(
            "it holds another TrustServiceStatusList",
        );
    });

    it("refuses a document whose root is not a TrustServiceStatusList", () => {
        expect(() =>
            readTrustedListXml('<?xml version="1.0"?><LoTE/>'),
        ).toThrow("its root is not a TrustServiceStatusList");
    });
});
