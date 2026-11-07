import { Injectable, Logger } from "@nestjs/common";
import type { LoTE } from "@owf/eudi-lote";
import {
    ServiceTypeIdentifier,
    serviceTypeMatches,
    TrustedEntity,
    TrustedEntityServiceCert,
    withdrawnServiceStatuses,
} from "./types.js";

type LoteInfo = {
    nextUpdate?: string;
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

@Injectable()
export class LoteParserService {
    private readonly logger = new Logger(LoteParserService.name);

    /**
     * Parse a LoTE payload preserving TrustedEntity groupings.
     * This allows pairing issuance and revocation certificates from the same entity.
     * Services whose status withdraws them ({@link withdrawnServiceStatuses})
     * are left out, so their certificates are no trust anchors.
     */
    parse(root: LoTE): ParsedLoTE {
        const schemeInfo = root.ListAndSchemeInformation;

        const info: LoteInfo = {
            nextUpdate: schemeInfo.NextUpdate,
            listIssueDateTime: schemeInfo.ListIssueDateTime,
            schemeTerritory: schemeInfo.SchemeTerritory,
        };

        const rawEntities = root.TrustedEntitiesList ?? [];
        const entities: TrustedEntity[] = [];

        this.logger.debug(
            `Parsing LoTE with ${rawEntities.length} raw TrustedEntities`,
        );

        for (const te of rawEntities) {
            // Extract entity ID from TrustedEntityInformation.TEName (array of MultiLangString)
            // Use the first name's value as the entity identifier
            const teName = te.TrustedEntityInformation?.TEName;
            const entityId = teName?.[0]?.value;

            this.logger.debug(`Processing entity: ${entityId || "(no id)"}`);

            const teServices = te.TrustedEntityServices ?? [];
            const entityServices: TrustedEntityServiceCert[] = [];

            this.logger.debug(`  Entity has ${teServices.length} services`);

            for (const svc of teServices) {
                const svcInfo = svc.ServiceInformation;
                const serviceTypeIdentifier = svcInfo?.ServiceTypeIdentifier;

                this.logger.debug(
                    `    Service type: ${serviceTypeIdentifier || "(none)"}`,
                );

                if (!serviceTypeIdentifier) {
                    this.logger.debug(
                        `    Skipping service without type identifier`,
                    );
                    continue;
                }

                if (
                    svcInfo.ServiceStatus &&
                    withdrawnServiceStatuses.includes(svcInfo.ServiceStatus)
                ) {
                    this.logger.debug(
                        `    Skipping withdrawn service (${svcInfo.ServiceStatus})`,
                    );
                    continue;
                }

                const x509s =
                    svcInfo.ServiceDigitalIdentity?.X509Certificates ?? [];

                this.logger.debug(
                    `    Service has ${x509s.length} X509 certificates`,
                );

                for (const x of x509s) {
                    if (x.val) {
                        const serviceCert: TrustedEntityServiceCert = {
                            serviceTypeIdentifier,
                            certValue: x.val,
                        };
                        entityServices.push(serviceCert);
                    } else {
                        this.logger.debug(`    X509 cert has no val property`);
                    }
                }
            }

            if (entityServices.length > 0) {
                entities.push({
                    entityId,
                    services: entityServices,
                });
                this.logger.debug(
                    `  Added entity ${entityId} with ${entityServices.length} service certs`,
                );
            } else {
                this.logger.debug(
                    `  Skipping entity ${entityId || "(no id)"} - no service certs found`,
                );
            }
        }

        return { info, entities };
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
