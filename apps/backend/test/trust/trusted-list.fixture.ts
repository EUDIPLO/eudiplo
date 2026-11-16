/**
 * ETSI TS 119 612 (V2.4.1) Trusted Lists for tests: a list of trusted lists
 * (LOTL) and national lists with QTSPs, as XML signed with an enveloped
 * XAdES-B-B signature (TS 119 612 clause 5.7, Annex B). `@owf/eudi-tl` only
 * reads and verifies Trusted Lists, so they are written here and signed with
 * xadesjs.
 */
import { randomUUID } from "node:crypto";
import type { X509Certificate } from "@peculiar/x509";
import { DOMImplementation, DOMParser, XMLSerializer } from "@xmldom/xmldom";
import * as xadesjs from "xadesjs";
import * as xpath from "xpath";

const DAY = 24 * 60 * 60 * 1000;
const TSL_NAMESPACE = "http://uri.etsi.org/02231/v2#";
const TSLX_NAMESPACE = "http://uri.etsi.org/02231/v2/additionaltypes#";

/** `TSLType` of a national list and of a list of trusted lists. */
export const TSL_TYPE = {
    EUgeneric: "http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUgeneric",
    EUlistofthelists:
        "http://uri.etsi.org/TrstSvc/TrustedList/TSLType/EUlistofthelists",
} as const;

/** Service types for the issuance of attestations of attributes. */
export const EAA_SERVICE_TYPE = {
    qualified: "http://uri.etsi.org/TrstSvc/Svctype/EAA/Q",
    notQualified: "http://uri.etsi.org/TrstSvc/Svctype/EAA",
} as const;

export const SERVICE_STATUS = {
    granted: "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted",
    withdrawn: "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/withdrawn",
    recognisedAtNationalLevel:
        "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/recognisedatnationallevel",
} as const;

/** A certificate with its private key, as `generateSelfSignedCertificate` returns it. */
export interface TrustedListSigner {
    certificate: X509Certificate;
    privateKey: CryptoKey;
}

/** One `TSPService` of a provider. */
interface TrustedListServiceSpec {
    certificates: X509Certificate[];
    type?: string;
    status?: string;
}

/** A `TrustServiceProvider`. */
interface TrustedListProviderSpec {
    name: string;
    services: TrustedListServiceSpec[];
}

/** An `OtherTSLPointer`. */
interface TrustedListPointerSpec {
    location: string;
    signers: X509Certificate[];
    tslType?: string;
    territory?: string;
    mimeType?: string;
}

export interface TrustedListSpec {
    /** `EUlistofthelists` for a LOTL, else a national list. */
    tslType?: string;
    territory?: string;
    sequenceNumber?: number;
    /** Default: 30 days from now; null leaves it out (a closed list). */
    nextUpdate?: Date | null;
    providers?: TrustedListProviderSpec[];
    pointers?: TrustedListPointerSpec[];
    /** Inserted after the XML declaration, for example a DOCTYPE. */
    prolog?: string;
}

const escape = (value: string) =>
    value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
const dateTime = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;
const der = (certificate: X509Certificate) => certificate.toString("base64");
const name = (tag: string, value: string) =>
    `<${tag}><Name xml:lang="en">${escape(value)}</Name></${tag}>`;

function service(spec: TrustedListServiceSpec, since: Date): string {
    const type = spec.type ?? EAA_SERVICE_TYPE.qualified;
    return (
        `<TSPService><ServiceInformation><ServiceTypeIdentifier>${type}</ServiceTypeIdentifier>` +
        name("ServiceName", "Issuance of attestations of attributes") +
        "<ServiceDigitalIdentity>" +
        spec.certificates
            .map(
                (cert) =>
                    `<DigitalId><X509Certificate>${der(cert)}</X509Certificate></DigitalId>`,
            )
            .join("") +
        "</ServiceDigitalIdentity>" +
        `<ServiceStatus>${spec.status ?? SERVICE_STATUS.granted}</ServiceStatus>` +
        `<StatusStartingTime>${dateTime(since)}</StatusStartingTime></ServiceInformation></TSPService>`
    );
}

function pointer(spec: TrustedListPointerSpec): string {
    return (
        "<OtherTSLPointer><ServiceDigitalIdentities>" +
        spec.signers
            .map(
                (cert) =>
                    `<ServiceDigitalIdentity><DigitalId><X509Certificate>${der(cert)}</X509Certificate></DigitalId></ServiceDigitalIdentity>`,
            )
            .join("") +
        `</ServiceDigitalIdentities><TSLLocation>${escape(spec.location)}</TSLLocation><AdditionalInformation>` +
        `<OtherInformation><TSLType>${spec.tslType ?? TSL_TYPE.EUgeneric}</TSLType></OtherInformation>` +
        `<OtherInformation><SchemeTerritory>${spec.territory ?? "DE"}</SchemeTerritory></OtherInformation>` +
        `<OtherInformation><tslx:MimeType>${spec.mimeType ?? "application/vnd.etsi.tsl+xml"}</tslx:MimeType></OtherInformation>` +
        "</AdditionalInformation></OtherTSLPointer>"
    );
}

/** The list as unsigned XML. */
function buildTrustedListXml(spec: TrustedListSpec, now = new Date()): string {
    const tslType = spec.tslType ?? TSL_TYPE.EUgeneric;
    const nextUpdate =
        spec.nextUpdate === undefined
            ? new Date(now.getTime() + 30 * DAY)
            : spec.nextUpdate;
    const since = new Date(now.getTime() - 30 * DAY);
    const providers = spec.providers ?? [];
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        (spec.prolog ?? "") +
        `<TrustServiceStatusList xmlns="${TSL_NAMESPACE}" xmlns:tslx="${TSLX_NAMESPACE}" TSLTag="http://uri.etsi.org/19612/TSLTag" Id="tsl-${randomUUID()}">` +
        "<SchemeInformation><TSLVersionIdentifier>6</TSLVersionIdentifier>" +
        `<TSLSequenceNumber>${spec.sequenceNumber ?? 1}</TSLSequenceNumber><TSLType>${tslType}</TSLType>` +
        name("SchemeOperatorName", "Test scheme operator") +
        name("SchemeName", "Test Trusted List, not for production use") +
        `<SchemeTerritory>${spec.territory ?? "DE"}</SchemeTerritory>` +
        (spec.pointers?.length
            ? `<PointersToOtherTSL>${spec.pointers.map(pointer).join("")}</PointersToOtherTSL>`
            : "") +
        `<ListIssueDateTime>${dateTime(now)}</ListIssueDateTime>` +
        (nextUpdate
            ? `<NextUpdate><dateTime>${dateTime(nextUpdate)}</dateTime></NextUpdate>`
            : "<NextUpdate/>") +
        "</SchemeInformation>" +
        (providers.length
            ? `<TrustServiceProviderList>${providers
                  .map(
                      (provider) =>
                          `<TrustServiceProvider><TSPInformation>${name("TSPName", provider.name)}</TSPInformation>` +
                          `<TSPServices>${provider.services.map((s) => service(s, since)).join("")}</TSPServices></TrustServiceProvider>`,
                  )
                  .join("")}</TrustServiceProviderList>`
            : "") +
        "</TrustServiceStatusList>\n"
    );
}

let xadesReady = false;

function ensureXades() {
    if (xadesReady) return;
    xadesjs.setNodeDependencies({
        DOMParser,
        XMLSerializer,
        DOMImplementation,
        xpath,
    } as never);
    xadesjs.Application.setEngine("NodeJS", globalThis.crypto);
    xadesReady = true;
}

/**
 * Sign the list with an enveloped XAdES-B-B signature: one reference to the
 * whole list with the enveloped-signature and exclusive canonicalization
 * transforms, ECDSA with SHA-256 and the signer certificate in `KeyInfo`.
 */
async function signTrustedList(
    xml: string,
    signer: TrustedListSigner,
    referenceRootId = false,
): Promise<string> {
    ensureXades();
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const rootId = document.documentElement?.getAttribute("Id");
    const signedXml = new xadesjs.SignedXml();
    signedXml.XmlSignature.SignedInfo.CanonicalizationMethod.Algorithm =
        "http://www.w3.org/2001/10/xml-exc-c14n#";
    const certificate = der(signer.certificate);
    const signature = await signedXml.Sign(
        { name: "ECDSA", hash: "SHA-256" } as Algorithm,
        signer.privateKey,
        document as never,
        {
            references: [
                {
                    id: `r-${randomUUID()}`,
                    uri: referenceRootId ? `#${rootId}` : "",
                    hash: "SHA-256",
                    transforms: ["enveloped", "exc-c14n"],
                },
            ],
            x509: [certificate],
            signingCertificateV2: certificate,
            signingTime: { value: new Date() },
        },
    );
    document.documentElement?.appendChild(signature.GetXml() as never);
    return new XMLSerializer().serializeToString(document);
}

/**
 * Build and sign a list. With `referenceRootId`, the signature references
 * the list by the `Id` of its root instead of with `URI=""`.
 */
export function buildSignedTrustedList(
    spec: TrustedListSpec,
    signer: TrustedListSigner,
    referenceRootId = false,
): Promise<string> {
    return signTrustedList(buildTrustedListXml(spec), signer, referenceRootId);
}
