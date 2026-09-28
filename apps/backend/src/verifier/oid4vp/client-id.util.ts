import type {
    CertificateInfo,
    CertService,
} from "../../crypto/key/cert/cert.service.js";
import type { ClientIdSchemeValue } from "./dto/presentation-request.dto.js";
import { ClientIdScheme } from "./dto/presentation-request.dto.js";

type ClientIdCertService = Pick<CertService, "getCertDnsName" | "getCertHash">;

export function createClientId(
    cert: CertificateInfo,
    certService: ClientIdCertService,
    scheme: ClientIdSchemeValue = ClientIdScheme.X509_HASH,
): string {
    if (scheme === ClientIdScheme.X509_SAN_DNS) {
        return `${scheme}:${certService.getCertDnsName(cert)}`;
    }

    return `${ClientIdScheme.X509_HASH}:${certService.getCertHash(cert)}`;
}
