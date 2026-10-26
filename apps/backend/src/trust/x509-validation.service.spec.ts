import { describe, expect, it } from "vitest";
import type { TrustedEntity } from "./types.js";
import { X509ValidationService } from "./x509-validation.service.js";

const PID_ISSUANCE = "http://uri.etsi.org/19602/SvcType/PID/Issuance";
const PID_REVOCATION = "http://uri.etsi.org/19602/SvcType/PID/Revocation";
const EAA_ISSUANCE = "http://uri.etsi.org/19602/SvcType/EAA/Issuance";
const EAA_REVOCATION = "http://uri.etsi.org/19602/SvcType/EAA/Revocation";

function entity(
    entityId: string,
    services: Array<[serviceTypeIdentifier: string, certValue: string]>,
): TrustedEntity {
    return {
        entityId,
        services: services.map(([serviceTypeIdentifier, certValue]) => ({
            serviceTypeIdentifier,
            certValue,
        })),
    };
}

describe("X509ValidationService.anchorCertValuesFor", () => {
    const service = new X509ValidationService();
    const entities = [
        entity("a", [
            [PID_ISSUANCE, "a-issuance"],
            [PID_REVOCATION, "a-revocation"],
        ]),
        entity("b", [
            [EAA_REVOCATION, "b-revocation"],
            [EAA_ISSUANCE, "b-issuance"],
        ]),
    ];
    const order = (filter: string) =>
        service
            .anchorCertValuesFor(entities, filter)
            .map(({ certValue }) => certValue);

    it("lists the services of the requested type first, keeping trust-list order in both groups", () => {
        expect(order("/Revocation")).toEqual([
            "a-revocation",
            "b-revocation",
            "a-issuance",
            "b-issuance",
        ]);
        expect(order("/Issuance")).toEqual([
            "a-issuance",
            "b-issuance",
            "a-revocation",
            "b-revocation",
        ]);
    });

    it("matches a full service type identifier exactly", () => {
        expect(order(EAA_REVOCATION)).toEqual([
            "b-revocation",
            "a-issuance",
            "a-revocation",
            "b-issuance",
        ]);
    });

    it("returns every certificate, also when no service matches", () => {
        expect(order("/Unknown")).toEqual([
            "a-issuance",
            "a-revocation",
            "b-revocation",
            "b-issuance",
        ]);
        expect(service.anchorCertValuesFor([], "/Issuance")).toEqual([]);
    });
});
