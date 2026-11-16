import {
    ServiceTypeIdentifiers,
    type TrustedEntity,
    type TrustListRef,
} from "../types.js";

/** A digital identity of a service or pointer: its certificate, if embedded. */
interface DigitalIdentity {
    /** Base64 DER. */
    certificate?: string;
}

/** A `TSPService` as these rules read it (clause 5.5). */
interface TrustedListService {
    serviceTypeIdentifier: string;
    /** The current `ServiceStatus`. */
    serviceStatus: string;
    digitalIdentities: DigitalIdentity[];
}

/** An `OtherTSLPointer` as these rules read it (clause 5.3.13). */
export interface TrustedListPointer {
    location: string;
    tslType?: string;
    schemeTerritory?: string;
    /** The `MimeType` of the pointed-to list, when the list names it. */
    mimeType?: string;
    digitalIdentities: DigitalIdentity[];
}

/** A Trusted List as these rules read it, once its signature is verified. */
export interface TrustedList {
    tslType?: string;
    providers: Array<{ name?: string; services: TrustedListService[] }>;
    pointersToOtherLists?: TrustedListPointer[];
}

/*
 * What EUDIPLO reads from an ETSI TS 119 612 Trusted List: the QTSPs with a
 * granted qualified service for the issuance of QEAAs, and, from a list of
 * trusted lists (LOTL), the national lists it points to.
 */

/** `ServiceStatus` of a qualified service with the qualified status (clause 5.5.4). */
const GRANTED = "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted"; // NOSONAR: ETSI identifier URI, not fetched

/** `TSLType` of a list of trusted lists (clause 5.3.3). */
const LIST_OF_THE_LISTS =
    "http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUlistofthelists"; // NOSONAR: ETSI identifier URI, not fetched

/** `TSLType` of a Member State's Trusted List (clause 5.3.3). */
const EU_GENERIC = "http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUgeneric"; // NOSONAR: ETSI identifier URI, not fetched

/**
 * Media types of a pointer to a Trusted List in XML (clause 6.2.1.1). A
 * pointer with another one, such as the PDF version of a list, is not
 * followed; one without a media type is.
 */
const XML_MEDIA_TYPES = new Set([
    "application/vnd.etsi.tsl+xml",
    "application/xml",
    "text/xml",
]);

/**
 * The most lists followed from one list of trusted lists. The EU LOTL points
 * to about 41 national lists, 32 of them in XML; each list followed is
 * fetched and its signature checked, one at a time, whenever the trust store
 * is built.
 */
export const MAX_FOLLOWED_TRUSTED_LISTS = 64;

/** Whether the list is a list of trusted lists, whose pointers are followed. */
export function isListOfTrustedLists(list: TrustedList): boolean {
    return list.tslType === LIST_OF_THE_LISTS;
}

/**
 * The QTSPs of a Trusted List with their granted qualified services for the
 * issuance of QEAAs, as trusted entities. Only a service of exactly that type
 * whose current status is exactly granted counts: a withdrawn service, a
 * service recognised at national level or one of another type (for example
 * the not qualified `Svctype/EAA`) adds no anchor. The current status
 * decides, so a QEAA issued before its service was withdrawn is no longer
 * trusted. Only digital identities with an X.509 certificate are kept, since
 * a certificate path must end at one; a subject name or key identifier alone
 * anchors nothing.
 */
export function qeaaProvidersOf(list: TrustedList): TrustedEntity[] {
    return list.providers.flatMap((provider) => {
        const services = provider.services
            .filter(
                (service) =>
                    service.serviceTypeIdentifier ===
                        ServiceTypeIdentifiers.QeaaIssuance &&
                    service.serviceStatus === GRANTED,
            )
            .flatMap((service) =>
                service.digitalIdentities.flatMap((identity) =>
                    identity.certificate
                        ? [
                              {
                                  serviceTypeIdentifier:
                                      ServiceTypeIdentifiers.QeaaIssuance,
                                  certValue: identity.certificate,
                              },
                          ]
                        : [],
                ),
            );
        return services.length > 0
            ? [{ entityId: provider.name, services }]
            : [];
    });
}

/** The pointer's media type, normalized; undefined when it names none. */
function mediaTypeOf(pointer: TrustedListPointer): string | undefined {
    const mediaType = pointer.mimeType?.trim().toLowerCase();
    return mediaType || undefined;
}

/**
 * The national lists a list of trusted lists points to, as references to
 * load: pointers of `TSLType` `EUgeneric` to a list in XML, in the given
 * territories if any, each to be verified with the certificates the list of
 * trusted lists publishes for it. Pointers to other lists of trusted lists
 * are not followed, and a location named twice is followed once.
 */
export function trustedListPointersToFollow(
    list: TrustedList,
    schemeTerritories?: readonly string[],
): TrustListRef[] {
    const territories = schemeTerritories?.map((territory) =>
        territory.trim().toUpperCase(),
    );
    const followed = new Map<string, TrustListRef>();
    for (const pointer of list.pointersToOtherLists ?? []) {
        const mediaType = mediaTypeOf(pointer);
        if (
            pointer.tslType !== EU_GENERIC ||
            (mediaType !== undefined && !XML_MEDIA_TYPES.has(mediaType)) ||
            (territories !== undefined &&
                !territories.includes(
                    pointer.schemeTerritory?.trim().toUpperCase() ?? "",
                )) ||
            followed.has(pointer.location)
        ) {
            continue;
        }
        followed.set(pointer.location, {
            format: "trusted-list",
            url: pointer.location,
            signingCertificates: pointer.digitalIdentities.flatMap(
                (identity) =>
                    identity.certificate ? [identity.certificate] : [],
            ),
        });
    }
    return [...followed.values()];
}

/**
 * A list of trusted lists points to more lists than
 * {@link MAX_FOLLOWED_TRUSTED_LISTS} after its `schemeTerritories` are
 * applied. The source is not used, as when a list cannot be loaded.
 */
export class TooManyTrustedListsError extends Error {
    constructor(
        readonly list: string,
        readonly lists: number,
    ) {
        super(
            `List of trusted lists ${list} points to ${lists} Trusted Lists to follow; at most ${MAX_FOLLOWED_TRUSTED_LISTS} are followed, so name the territories to follow in schemeTerritories`,
        );
        this.name = "TooManyTrustedListsError";
    }
}
