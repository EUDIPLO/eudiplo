import { ServiceTypeIdentifiers } from "../types.js";

/**
 * What the profile of a trust list (LoTE, ETSI TS 119 602 V1.1.1) says about
 * its services, looked up by the list's `LoTEType`:
 *
 * - **Service type.** `ServiceTypeIdentifier` is optional (6.6.0); when it is
 *   absent, "all services are of the same type in the scheme" (NOTE 2). In a
 *   list where no service has a type, each service gets the issuance type of
 *   the list's profile. Each of Annexes D to H allows an issuance and a
 *   revocation type, and a list of one type lists the providers' issuing
 *   services. NOTE 2 does not name the type, so this is an assumption: an
 *   untyped list of revocation services only would make their certificates
 *   issuance anchors. Typed lists, which every EUDIPLO list is, are read by
 *   their types alone.
 * - **Service status.** `ServiceStatus` is optional too; when it is absent,
 *   "all services have the same approval status" (NOTE 1). Annexes D, E, F, G
 *   and I say "The ServiceStatus component shall not be used", so any value
 *   there leaves the service out. Annex H (Table H.3) says it "shall be
 *   present" and allows `notified` and `withdrawn` "to the exclusion of any
 *   other". A Pub-EAA service without a status is still read, with a warning:
 *   the list is signed, an absent status cannot mean withdrawn (NOTE 1), and
 *   `@owf/eudi-lote` (0.5) forbids the component in its Pub-EAA schema, so
 *   lists built with it carry none. Other lists accept
 *   no status, Annex H's `notified` and the profile-independent
 *   `commons/schemeApprovalGranted` (draft ETSI EN 319 602 V1.1.3).
 *
 * Every value not approving a service leaves it out, so a scheme that defines
 * its own status URIs (6.6.4) is not trusted until they are known here.
 */

/** List types of ETSI TS 119 602 Annex C.2, plus the one EUDIPLO publishes. */
export const LoteTypes = {
    PIDProviders: "http://uri.etsi.org/19602/LoTEType/EUPIDProvidersList", // NOSONAR: ETSI identifier URI, not fetched
    WalletProviders: "http://uri.etsi.org/19602/LoTEType/EUWalletProvidersList", // NOSONAR: ETSI identifier URI, not fetched
    WRPACProviders: "http://uri.etsi.org/19602/LoTEType/EUWRPACProvidersList", // NOSONAR: ETSI identifier URI, not fetched
    WRPRCProviders: "http://uri.etsi.org/19602/LoTEType/EUWRPRCProvidersList", // NOSONAR: ETSI identifier URI, not fetched
    PubEAAProviders: "http://uri.etsi.org/19602/LoTEType/EUPubEAAProvidersList", // NOSONAR: ETSI identifier URI, not fetched
    RegistrarsAndRegisters:
        "http://uri.etsi.org/19602/LoTEType/EURegistrarsAndRegistersList", // NOSONAR: ETSI identifier URI, not fetched
    /** The lists of EAA providers EUDIPLO publishes; no annex defines it. */
    EAAProviders: "http://uri.etsi.org/19602/LoTEType/EUEAAProvidersList", // NOSONAR: ETSI identifier URI, not fetched
} as const;

export const ServiceStatuses = {
    /** ETSI TS 119 602 Annex H, Table H.3. */
    PubEAANotified:
        "http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/notified", // NOSONAR: ETSI identifier URI, not fetched
    /** ETSI TS 119 602 Annex H, Table H.3. */
    PubEAAWithdrawn:
        "http://uri.etsi.org/19602/PubEAAProvidersList/SvcStatus/withdrawn", // NOSONAR: ETSI identifier URI, not fetched
    /** Draft ETSI EN 319 602 V1.1.3, C.2.5. */
    SchemeApprovalGranted:
        "http://uri.etsi.org/19602/commons/schemeApprovalGranted", // NOSONAR: ETSI identifier URI, not fetched
    /** Draft ETSI EN 319 602 V1.1.3, C.2.5. */
    SchemeApprovalWithdrawn:
        "http://uri.etsi.org/19602/commons/schemeApprovalWithdrawn", // NOSONAR: ETSI identifier URI, not fetched
} as const;

/** Statuses saying that a service is no longer approved, in any list. */
const withdrawnServiceStatuses: ReadonlySet<string> = new Set([
    ServiceStatuses.PubEAAWithdrawn,
    ServiceStatuses.SchemeApprovalWithdrawn,
]);

export interface LoteProfileRules {
    /**
     * The type of a service without `ServiceTypeIdentifier` in a list where
     * no service has one; absent when the profile implies none.
     */
    impliedServiceType?: string;
    /** `ServiceStatus` values that approve a service; empty when the profile forbids the component. */
    approvingStatuses: readonly string[];
    /**
     * Whether a service without `ServiceStatus` is read with a warning,
     * because the profile requires the component.
     */
    statusRequired: boolean;
}

/** Annexes D to G and I: "The ServiceStatus component shall not be used". */
const statusForbidden = {
    approvingStatuses: [],
    statusRequired: false,
} as const satisfies LoteProfileRules;

/** Lists of no EU profile, including the ones EUDIPLO publishes. */
const otherListStatuses = {
    approvingStatuses: [
        ServiceStatuses.PubEAANotified,
        ServiceStatuses.SchemeApprovalGranted,
    ],
    statusRequired: false,
} as const satisfies LoteProfileRules;

const profiles: ReadonlyMap<string, LoteProfileRules> = new Map<
    string,
    LoteProfileRules
>([
    [
        LoteTypes.PIDProviders,
        {
            ...statusForbidden,
            impliedServiceType: ServiceTypeIdentifiers.PIDIssuance,
        },
    ],
    [
        LoteTypes.WalletProviders,
        {
            ...statusForbidden,
            impliedServiceType: ServiceTypeIdentifiers.WalletSolutionIssuance,
        },
    ],
    // Nothing in EUDIPLO reads the services of these lists by type.
    [LoteTypes.WRPACProviders, statusForbidden],
    [LoteTypes.WRPRCProviders, statusForbidden],
    [LoteTypes.RegistrarsAndRegisters, statusForbidden],
    [
        LoteTypes.PubEAAProviders,
        {
            impliedServiceType: ServiceTypeIdentifiers.PubEaaIssuance,
            approvingStatuses: [ServiceStatuses.PubEAANotified],
            statusRequired: true,
        },
    ],
    [
        LoteTypes.EAAProviders,
        {
            ...otherListStatuses,
            impliedServiceType: ServiceTypeIdentifiers.EaaIssuance,
        },
    ],
]);

/** The rules for a list of this `LoTEType`, which may be absent or unknown. */
export function loteProfileRules(
    loteType: string | undefined,
): LoteProfileRules {
    return (loteType && profiles.get(loteType)) || otherListStatuses;
}

/** Why a service is left out of a list, or read with a warning. */
export type LoteServiceNote =
    /** No `ServiceTypeIdentifier`, while other services of the list have one. */
    | "untyped-in-mixed-list"
    /** No `ServiceTypeIdentifier`, and the list type implies none. */
    | "untyped-without-implied-type"
    /** A status saying the service is no longer approved. */
    | "status-withdrawn"
    /** A status in a list whose profile forbids `ServiceStatus`. */
    | "status-not-used"
    /** A status the list type does not approve services with. */
    | "status-unknown"
    /** Read: no status, although the profile requires one. */
    | "status-missing";

export type ServiceStatusVerdict =
    | { keep: true; note?: "status-missing" }
    | {
          keep: false;
          note: "status-withdrawn" | "status-not-used" | "status-unknown";
      };

/** Whether a service with this `ServiceStatus` is read from the list. */
export function serviceStatusVerdict(
    rules: LoteProfileRules,
    status: string | undefined,
): ServiceStatusVerdict {
    if (!status) {
        return rules.statusRequired
            ? { keep: true, note: "status-missing" }
            : { keep: true };
    }
    if (rules.approvingStatuses.includes(status)) return { keep: true };
    if (withdrawnServiceStatuses.has(status)) {
        return { keep: false, note: "status-withdrawn" };
    }
    return {
        keep: false,
        note:
            rules.approvingStatuses.length === 0
                ? "status-not-used"
                : "status-unknown",
    };
}

/**
 * Whether any service of the list has a `ServiceTypeIdentifier`; untyped
 * services then get no implied type. Counted before statuses are checked, so
 * a typed service that is left out still makes the list a mixed one.
 */
export function listHasTypedServices(
    serviceTypes: Iterable<string | undefined>,
): boolean {
    for (const type of serviceTypes) if (type) return true;
    return false;
}

/**
 * The type a service is read with: its own, or the type the list implies
 * when no service of the list has one ({@link listHasTypedServices}).
 */
export function effectiveServiceType(
    rules: LoteProfileRules,
    serviceType: string | undefined,
    typedList: boolean,
):
    | { type: string }
    | {
          type?: undefined;
          note: "untyped-in-mixed-list" | "untyped-without-implied-type";
      } {
    if (serviceType) return { type: serviceType };
    if (typedList) return { note: "untyped-in-mixed-list" };
    return rules.impliedServiceType
        ? { type: rules.impliedServiceType }
        : { note: "untyped-without-implied-type" };
}
