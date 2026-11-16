import {
    loadTrustedList,
    type TrustedList as ParsedTrustedList,
} from "@owf/eudi-tl";
import {
    isListOfTrustedLists,
    qeaaProvidersOf,
    type TrustedList,
    trustedListPointersToFollow,
} from "../domain/trusted-list-services.js";
import type {
    TrustListProvider,
    VerifiedTrustList,
} from "../ports/trust-list-provider.js";
import {
    TRUST_LIST_MAX_BYTES,
    type TrustFetchService,
} from "../trust-fetch.service.js";
import type { TrustListRef } from "../types.js";
import { readTrustedListXml } from "./trusted-list-xml.js";

/** National lists are larger than LoTEs and served by many operators. */
const TRUSTED_LIST_FETCH_TIMEOUT_MS = 10_000;

/**
 * Bounds the ASN.1 parsing of each certificate a list embeds: real
 * certificates nest a few levels deep and hold a few hundred nodes.
 */
const CERTIFICATE_PARSE_OPTIONS = {
    berOptions: { maxDepth: 32, maxNodes: 4000, maxContentLength: 64 * 1024 },
};

/**
 * Fetches an ETSI TS 119 612 Trusted List, verifies its XAdES signature
 * against the pinned signing certificates with `@owf/eudi-tl`, and exposes
 * the QTSPs of its granted qualified QEAA services. For a list of trusted
 * lists it also returns the national lists to follow.
 */
export class VerifiedTrustedListProvider implements TrustListProvider {
    constructor(private readonly trustFetch: Pick<TrustFetchService, "get">) {}

    async loadVerified(reference: TrustListRef): Promise<VerifiedTrustList> {
        const { list, pointerMediaTypes } = await this.load(reference);
        const rules: TrustedList = {
            ...list,
            pointersToOtherLists: list.pointersToOtherLists?.map((pointer) => ({
                ...pointer,
                mimeType: pointerMediaTypes.get(pointer.location),
            })),
        };
        return {
            nextUpdate: list.nextUpdate,
            sequenceNumber: list.sequenceNumber,
            entities: qeaaProvidersOf(rules),
            ...(isListOfTrustedLists(rules)
                ? {
                      pointers: trustedListPointersToFollow(
                          rules,
                          reference.schemeTerritories,
                      ),
                  }
                : {}),
        };
    }

    /**
     * The list, parsed only once its signature verified with the key of one
     * of the reference's signing certificates, with the `MimeType` of each
     * pointer, which `@owf/eudi-tl` does not report.
     * @throws when the list cannot be fetched, declares a DOCTYPE, has a
     * signature outside the profile of TS 119 612 ({@link readTrustedListXml}),
     * or is not a validly signed Trusted List
     */
    private async load(reference: TrustListRef): Promise<{
        list: ParsedTrustedList;
        pointerMediaTypes: Map<string, string>;
    }> {
        const xml = await this.fetchXml(reference.url);
        // TS 119 612 lists carry no document type declaration; refusing one
        // keeps entity declarations out of the parser.
        if (/<!DOCTYPE/i.test(xml)) {
            throw new Error(
                `Trusted List ${reference.url} declares a DOCTYPE, which an ETSI TS 119 612 list does not have`,
            );
        }
        let read: ReturnType<typeof readTrustedListXml>;
        try {
            read = readTrustedListXml(xml);
        } catch (error) {
            throw new Error(
                `Trusted List ${reference.url} is refused before its signature is checked: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        const trustAnchors = (reference.signingCertificates ?? []).map(
            (certificate) =>
                new Uint8Array(
                    Buffer.from(certificate.replaceAll(/\s/g, ""), "base64"),
                ),
        );
        try {
            const list = await loadTrustedList(xml, {
                trustAnchors,
                certificateParseOptions: CERTIFICATE_PARSE_OPTIONS,
            });
            return { list, pointerMediaTypes: read.pointerMediaTypes };
        } catch (error) {
            throw new Error(
                `Trusted List ${reference.url} is not a Trusted List signed by one of its signing certificates: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }

    private async fetchXml(url: string): Promise<string> {
        try {
            const response = await this.trustFetch.get(url, {
                timeoutMs: TRUSTED_LIST_FETCH_TIMEOUT_MS,
                maxBytes: TRUST_LIST_MAX_BYTES,
                accept: "application/vnd.etsi.tsl+xml, application/xml;q=0.9, text/xml;q=0.8",
            });
            return response.body;
        } catch (error) {
            throw new Error(
                `Failed to fetch Trusted List from ${url}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }
}
