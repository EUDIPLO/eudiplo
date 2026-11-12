import { Injectable, Logger } from "@nestjs/common";
import type { LoTE } from "@owf/eudi-lote";
import {
    effectiveServiceType,
    type LoteProfileRules,
    type LoteServiceNote,
    listHasTypedServices,
    loteProfileRules,
    serviceStatusVerdict,
} from "./domain/lote-profiles.js";
import {
    ServiceTypeIdentifier,
    serviceTypeMatches,
    TrustedEntity,
    TrustedEntityServiceCert,
} from "./types.js";

type LoteInfo = {
    nextUpdate?: string;
    /** `LoTESequenceNumber` as signed; not checked here. */
    sequenceNumber?: unknown;
    listIssueDateTime?: string;
    schemeTerritory?: string;
};

/**
 * Parsed LoTE preserving TrustedEntity groupings.
 * This is important for pairing issuance and revocation certificates from the same entity.
 */
export type ParsedLoTE = {
    info: LoteInfo;
    /** TrustedEntities with their services grouped */
    entities: TrustedEntity[];
};

/** A service left out of a list, or read with a warning. */
type NotedService = {
    entityId?: string;
    serviceType?: string;
    status?: string;
    note: LoteServiceNote;
};

const noteText: Record<LoteServiceNote, string> = {
    "untyped-in-mixed-list":
        "no ServiceTypeIdentifier, while other services of the list have one",
    "untyped-without-implied-type":
        "no ServiceTypeIdentifier, and the list type implies none",
    "status-withdrawn": "its ServiceStatus withdraws it",
    "status-not-used": "the list type does not use ServiceStatus",
    "status-unknown":
        "the list type does not approve services with this ServiceStatus",
    "status-missing": "no ServiceStatus, which the list type requires",
};

/** Services named per kind in a warning; a list may hold many. */
const MAX_NAMED_SERVICES = 10;

/** One service for the log; values from the list are quoted and escaped. */
function describeService({
    entityId,
    serviceType,
    status,
    note,
}: NotedService): string {
    const parts = [
        `entity ${JSON.stringify(entityId ?? "(no name)")}`,
        `type ${serviceType ? JSON.stringify(serviceType) : "(none)"}`,
    ];
    if (status) parts.push(`status ${JSON.stringify(status)}`);
    return `${parts.join(", ")}: ${noteText[note]}`;
}

function describeServices(services: NotedService[]): string {
    const named = services
        .slice(0, MAX_NAMED_SERVICES)
        .map(describeService)
        .join("; ");
    const more = services.length - MAX_NAMED_SERVICES;
    return more > 0 ? `${named}; and ${more} more` : named;
}

type LoteService = NonNullable<
    NonNullable<LoTE["TrustedEntitiesList"]>[number]["TrustedEntityServices"]
>[number];

/** One service as read: its certificates, or why it was left out or warned about. */
type ServiceRead =
    | { certs: TrustedEntityServiceCert[]; warning?: NotedService }
    | { certs: []; leftOut: NotedService };

/**
 * The certificates of one service, with the type it is read with; none when
 * the list's rules leave it out.
 */
function readService(
    svc: LoteService,
    entityId: string | undefined,
    rules: LoteProfileRules,
    typedList: boolean,
): ServiceRead {
    const svcInfo = svc.ServiceInformation;
    const status = svcInfo?.ServiceStatus;
    const resolved = effectiveServiceType(
        rules,
        svcInfo?.ServiceTypeIdentifier,
        typedList,
    );
    if (resolved.type === undefined) {
        return {
            certs: [],
            leftOut: { entityId, status, note: resolved.note },
        };
    }
    const serviceTypeIdentifier = resolved.type;
    const noted = { entityId, serviceType: serviceTypeIdentifier, status };

    const verdict = serviceStatusVerdict(rules, status);
    if (!verdict.keep) {
        return { certs: [], leftOut: { ...noted, note: verdict.note } };
    }
    const certs = (
        svcInfo?.ServiceDigitalIdentity?.X509Certificates ?? []
    ).flatMap((x) =>
        x.val ? [{ serviceTypeIdentifier, certValue: x.val }] : [],
    );
    return verdict.note
        ? { certs, warning: { ...noted, note: verdict.note } }
        : { certs };
}

@Injectable()
export class LoteParserService {
    private readonly logger = new Logger(LoteParserService.name);

    /**
     * Parse a LoTE payload preserving TrustedEntity groupings.
     * This allows pairing issuance and revocation certificates from the same entity.
     * Services are read by the rules of the list's `LoTEType`
     * ({@link loteProfileRules}): an untyped service gets the type the list
     * implies, and a service whose `ServiceStatus` does not approve it is
     * left out, so its certificates are no trust anchors. One warning per
     * list names the services left out or read despite a missing status.
     *
     * @param list URL of the list, or the ID of a managed list, for the log.
     */
    parse(root: LoTE, list: string): ParsedLoTE {
        const schemeInfo = root.ListAndSchemeInformation;

        const info: LoteInfo = {
            nextUpdate: schemeInfo.NextUpdate,
            sequenceNumber: schemeInfo.LoTESequenceNumber,
            listIssueDateTime: schemeInfo.ListIssueDateTime,
            schemeTerritory: schemeInfo.SchemeTerritory,
        };

        const rules = loteProfileRules(schemeInfo.LoTEType);
        const rawEntities = root.TrustedEntitiesList ?? [];
        const typedList = listHasTypedServices(
            (function* () {
                for (const te of rawEntities) {
                    for (const svc of te.TrustedEntityServices ?? []) {
                        yield svc.ServiceInformation?.ServiceTypeIdentifier;
                    }
                }
            })(),
        );
        const entities: TrustedEntity[] = [];
        const leftOut: NotedService[] = [];
        const keptWithWarning: NotedService[] = [];

        for (const te of rawEntities) {
            // The first name identifies the entity.
            const entityId = te.TrustedEntityInformation?.TEName?.[0]?.value;
            const entityServices: TrustedEntityServiceCert[] = [];
            for (const svc of te.TrustedEntityServices ?? []) {
                const read = readService(svc, entityId, rules, typedList);
                if ("leftOut" in read) leftOut.push(read.leftOut);
                else if (read.warning) keptWithWarning.push(read.warning);
                entityServices.push(...read.certs);
            }
            if (entityServices.length > 0) {
                entities.push({ entityId, services: entityServices });
            }
        }

        this.warnNotedServices(list, leftOut, keptWithWarning);
        return { info, entities };
    }

    private warnNotedServices(
        list: string,
        leftOut: NotedService[],
        keptWithWarning: NotedService[],
    ) {
        if (leftOut.length === 0 && keptWithWarning.length === 0) return;
        const parts: string[] = [];
        if (leftOut.length > 0) {
            parts.push(
                `left out ${leftOut.length} service(s): ${describeServices(leftOut)}`,
            );
        }
        if (keptWithWarning.length > 0) {
            parts.push(
                `read ${keptWithWarning.length} service(s) despite: ${describeServices(keptWithWarning)}`,
            );
        }
        this.logger.warn(`Trust list ${list}: ${parts.join(". ")}`);
    }

    /**
     * Filter entities to only include those that have at least one service matching the accepted types.
     * Keeps all services of matching entities (not just the matching services).
     */
    filterByServiceTypes(
        parsed: ParsedLoTE,
        accepted: ServiceTypeIdentifier[],
    ): ParsedLoTE {
        const filteredEntities = parsed.entities.filter((entity) =>
            entity.services.some((s) =>
                accepted.some((acceptedType) =>
                    serviceTypeMatches(s.serviceTypeIdentifier, acceptedType),
                ),
            ),
        );

        return {
            info: parsed.info,
            entities: filteredEntities,
        };
    }
}
