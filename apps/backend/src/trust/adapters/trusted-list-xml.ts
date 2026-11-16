import { DOMParser, type Element } from "@xmldom/xmldom";

const TSL_NS = "http://uri.etsi.org/02231/v2#";
const TSLX_NS = "http://uri.etsi.org/02231/v2/additionaltypes#";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const XADES_NS = "http://uri.etsi.org/01903/v1.3.2#";
const SIGNED_PROPERTIES_TYPE = "http://uri.etsi.org/01903#SignedProperties";

/**
 * The most references a Trusted List's signature may have. Annex B needs
 * two: one to the list and one to the XAdES signed properties. Each one is
 * resolved and digested before the signature value is checked.
 */
const MAX_REFERENCES = 8;

/** Canonicalization methods of `SignedInfo` and of references. */
const CANONICALIZATIONS = new Set([
    "http://www.w3.org/2001/10/xml-exc-c14n#",
    "http://www.w3.org/2001/10/xml-exc-c14n#WithComments",
    "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    "http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments",
    "http://www.w3.org/2006/12/xml-c14n11",
    "http://www.w3.org/2006/12/xml-c14n11#WithComments",
]);

/** Transforms of a reference: the enveloped signature and canonicalization. */
const TRANSFORMS = new Set([
    "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
    ...CANONICALIZATIONS,
]);

/** What EUDIPLO reads from a Trusted List besides `@owf/eudi-tl`. */
export interface TrustedListXml {
    /**
     * The `MimeType` of each `OtherTSLPointer` that names one, by its
     * `TSLLocation` (ETSI TS 119 612 clause 5.3.13); the first one counts.
     */
    pointerMediaTypes: Map<string, string>;
}

/**
 * Check a Trusted List's signature against the profile of ETSI TS 119 612
 * before the signature is verified, and read the media types of its
 * pointers, which `@owf/eudi-tl` does not report.
 *
 * Checking a reference applies its transforms to the document, and the
 * signature is only checked afterwards; so a transform such as XPath,
 * evaluated per node, would run on whatever whoever serves the list put
 * there (XML Signature Best Practices, section 2.1). A reference that names
 * another element than the list's root would let a list signed once be
 * wrapped into another root with other content (section 2.3); Annex B.1.0
 * requires a reference to the `TrustServiceStatusList` itself.
 *
 * Accepted: one `TrustServiceStatusList`, the document root, with one
 * `ds:Signature` as its child and no other `ds:SignedInfo` in the document;
 * at most {@link MAX_REFERENCES} references, with only the enveloped-signature
 * and canonicalization transforms; `SignedInfo` canonicalized by one of
 * these; and every reference either to the whole list (`URI=""`, or `#` and
 * the root's `Id` when no other element has that `Id`) or to the one element
 * of that `Id` inside the signature, such as its XAdES `SignedProperties`
 * or its `KeyInfo`. At least one reference covers the list, so the pointers read here are signed
 * once the signature verifies. Every check is one pass over the document or
 * the signature, whatever the list holds.
 * @throws Error naming the first part outside this profile
 */
export function readTrustedListXml(xml: string): TrustedListXml {
    const document = new DOMParser({
        onError: () => {
            // Recoverable errors are left to the verification that follows;
            // a fatal one throws here.
        },
    }).parseFromString(xml, "application/xml") as unknown as Document;
    const root = document.documentElement as unknown as Element | null;
    if (
        !root ||
        root.namespaceURI !== TSL_NS ||
        root.localName !== "TrustServiceStatusList"
    ) {
        throw new Error("its root is not a TrustServiceStatusList");
    }
    if (
        root.getElementsByTagNameNS(TSL_NS, "TrustServiceStatusList").length > 0
    ) {
        throw new Error("it holds another TrustServiceStatusList");
    }
    assertSignatureProfile(root);
    return { pointerMediaTypes: pointerMediaTypes(root) };
}

/** See {@link readTrustedListXml}. */
function assertSignatureProfile(root: Element): void {
    const signatures = children(root, DSIG_NS, "Signature");
    const signedInfos = signatures.flatMap((signature) =>
        children(signature, DSIG_NS, "SignedInfo"),
    );
    if (
        signatures.length !== 1 ||
        signedInfos.length !== 1 ||
        root.getElementsByTagNameNS(DSIG_NS, "SignedInfo").length !== 1
    ) {
        throw new Error(
            "it does not have exactly one signature, with one SignedInfo, as a child of its root",
        );
    }
    const signature = signatures[0];
    const signedInfo = signedInfos[0];
    for (const method of children(
        signedInfo,
        DSIG_NS,
        "CanonicalizationMethod",
    )) {
        const algorithm = method.getAttribute("Algorithm") ?? "";
        if (!CANONICALIZATIONS.has(algorithm)) {
            throw new Error(
                `its signature uses the canonicalization ${JSON.stringify(algorithm)}`,
            );
        }
    }
    for (const transform of Array.from(
        signedInfo.getElementsByTagNameNS(
            DSIG_NS,
            "Transform",
        ) as unknown as Element[],
    )) {
        const algorithm = transform.getAttribute("Algorithm") ?? "";
        if (!TRANSFORMS.has(algorithm)) {
            throw new Error(
                `its signature uses the transform ${JSON.stringify(algorithm)}`,
            );
        }
    }
    const references = children(signedInfo, DSIG_NS, "Reference");
    if (references.length > MAX_REFERENCES) {
        throw new Error(
            `its signature has ${references.length} references; at most ${MAX_REFERENCES} are accepted`,
        );
    }
    const uris = references.map((reference) => reference.getAttribute("URI"));
    const ids = elementsById(
        root,
        new Set(
            uris.flatMap((uri) => (uri?.startsWith("#") ? [uri.slice(1)] : [])),
        ),
    );
    const rootId = root.getAttribute("Id");
    let coversList = false;
    references.forEach((reference, index) => {
        const uri = uris[index];
        if (
            uri === "" ||
            (rootId && uri === `#${rootId}` && ids.get(rootId)?.length === 1)
        ) {
            coversList = true;
            return;
        }
        // Annex B.1.0 rule 4 allows other references, such as the XAdES
        // signed properties or the signature's KeyInfo; they sign more, but
        // only one inside the signature cannot take the list's place.
        const targets = uri?.startsWith("#")
            ? (ids.get(uri.slice(1)) ?? [])
            : [];
        const signedProperties =
            reference.getAttribute("Type") === SIGNED_PROPERTIES_TYPE &&
            targets[0]?.namespaceURI === XADES_NS &&
            targets[0]?.localName === "SignedProperties";
        if (
            targets.length !== 1 ||
            !(signedProperties || isWithin(targets[0], signature))
        ) {
            throw new Error(
                `its signature references ${JSON.stringify(uri)}, which is neither the whole list nor part of its signature`,
            );
        }
    });
    if (!coversList) {
        throw new Error("its signature does not reference the whole list");
    }
}

/** Whether `element` is `ancestor` or below it. */
function isWithin(element: Element, ancestor: Element): boolean {
    for (
        let node: Element | null = element;
        node;
        node = node.parentNode as Element | null
    ) {
        if (node === ancestor) return true;
    }
    return false;
}

/**
 * The elements under and including `root` whose `Id`, `ID` or `id` is one of
 * `wanted`, in one pass over the document.
 */
function elementsById(
    root: Element,
    wanted: Set<string>,
): Map<string, Element[]> {
    const found = new Map<string, Element[]>();
    if (wanted.size === 0) return found;
    const all = [
        root,
        ...Array.from(root.getElementsByTagName("*") as unknown as Element[]),
    ];
    for (const element of all) {
        for (const name of ["Id", "ID", "id"]) {
            const value = element.getAttribute(name);
            if (value !== null && wanted.has(value)) {
                const elements = found.get(value);
                if (elements) elements.push(element);
                else found.set(value, [element]);
            }
        }
    }
    return found;
}

/**
 * See {@link TrustedListXml.pointerMediaTypes}: read along the path the
 * schema gives, `SchemeInformation/PointersToOtherTSL/OtherTSLPointer`, with
 * the media type in `AdditionalInformation/OtherInformation/MimeType`.
 */
function pointerMediaTypes(root: Element): Map<string, string> {
    const mediaTypes = new Map<string, string>();
    const pointers = children(root, TSL_NS, "SchemeInformation")
        .flatMap((info) => children(info, TSL_NS, "PointersToOtherTSL"))
        .flatMap((list) => children(list, TSL_NS, "OtherTSLPointer"));
    for (const pointer of pointers) {
        const location = children(
            pointer,
            TSL_NS,
            "TSLLocation",
        )[0]?.textContent?.trim();
        const mediaType = children(pointer, TSL_NS, "AdditionalInformation")
            .flatMap((info) => children(info, TSL_NS, "OtherInformation"))
            .flatMap((other) => children(other, TSLX_NS, "MimeType"))[0]
            ?.textContent?.trim();
        if (location && mediaType && !mediaTypes.has(location)) {
            mediaTypes.set(location, mediaType);
        }
    }
    return mediaTypes;
}

/** The child elements of `parent` with this namespace and local name. */
function children(parent: Element, namespace: string, name: string): Element[] {
    return Array.from(
        parent.childNodes as unknown as ArrayLike<Element>,
    ).filter(
        (node) => node.namespaceURI === namespace && node.localName === name,
    );
}
