import { DateOnly, IssuerSigned } from "@owf/mdoc";
import * as x509 from "@peculiar/x509";
import { exportJWK } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CertService } from "../../../../../crypto/key/cert/cert.service.js";
import type { KeyChainService } from "../../../../../crypto/key/key-chain.service.js";
import type { SessionData } from "../../../../../session/domain/session-data.js";
import type { StatusListService } from "../../../../status-list/status-list.service.js";
import { InvalidCredentialClaims } from "../../domain/credential-claims-validation.js";
import type { CredentialConfiguration } from "../../domain/credential-configuration.js";
import type { ClaimFieldDefinition } from "../../utils/types.js";
import { MdocIssuerService } from "./mdoc-issuer.service.js";

const NAMESPACE = "eu.europa.ec.eudi.pid.1";
const TAG_1004 = [0xd9, 0x03, 0xec];
const TAG_0 = [0xc0];

/** The encoded IssuerSignedItem bytes of each element, by identifier. */
function itemBytes(issuerSigned: IssuerSigned): Map<string, Uint8Array> {
    const result = new Map<string, Uint8Array>();
    for (const item of issuerSigned.issuerNamespaces?.issuerNamespaces.get(
        NAMESPACE,
    ) ?? []) {
        result.set(item.elementIdentifier, item.encode());
    }
    return result;
}

/** Whether `bytes` holds `prefix` directly followed by the CBOR text string `text`. */
function hasTagged(bytes: Uint8Array, prefix: number[], text: string): boolean {
    const encodedText = new TextEncoder().encode(text);
    const needle = [...prefix, 0x60 + encodedText.length, ...encodedText];
    const haystack = Array.from(bytes);
    return haystack.some((_, start) =>
        needle.every((byte, offset) => haystack[start + offset] === byte),
    );
}

describe("MdocIssuerService date claims", () => {
    let service: MdocIssuerService;
    let deviceKey: Record<string, unknown>;

    beforeAll(async () => {
        x509.cryptoProvider.set(crypto);
        const algorithm = { name: "ECDSA", namedCurve: "P-256" };
        const issuerKeys = await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]);
        const certificate =
            await x509.X509CertificateGenerator.createSelfSigned({
                serialNumber: "01",
                name: "C=DE, CN=Test PID Issuer",
                notBefore: new Date(Date.now() - 2 * 3_600_000),
                notAfter: new Date(Date.now() + 30 * 24 * 3_600_000),
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                keys: issuerKeys,
            });
        const activeJwk = await exportJWK(issuerKeys.privateKey);
        const deviceKeys = await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]);
        deviceKey = (await exportJWK(deviceKeys.publicKey)) as Record<
            string,
            unknown
        >;

        const certService = {
            find: vi.fn().mockResolvedValue({
                keyId: "attestation",
                crt: [certificate.toString("pem")],
            }),
        } as unknown as CertService;
        const keyChainService = {
            getEntity: vi.fn().mockResolvedValue({ activeJwk }),
        } as unknown as KeyChainService;
        service = new MdocIssuerService(
            certService,
            keyChainService,
            {} as StatusListService,
        );
    });

    async function issue(
        fields: ClaimFieldDefinition[],
        claims: Record<string, unknown>,
    ): Promise<IssuerSigned> {
        const encoded = await service.issue({
            credentialConfiguration: {
                id: "pid-mdoc",
                config: { format: "mso_mdoc", docType: NAMESPACE },
                keyChainId: "attestation",
                lifeTime: 24 * 3600,
                fields,
            } as unknown as CredentialConfiguration,
            deviceKey: deviceKey as never,
            session: { tenantId: "tenant" } as SessionData,
            claims,
        });
        return IssuerSigned.fromEncodedForOid4Vci(encoded);
    }

    const dateFields: ClaimFieldDefinition[] = [
        {
            namespace: NAMESPACE,
            path: ["birth_date"],
            type: "string",
            format: "date",
            defaultValue: "1964-08-12",
        },
        {
            namespace: NAMESPACE,
            path: ["issuance_date"],
            type: "string",
            format: "date-time",
        },
        {
            namespace: NAMESPACE,
            path: ["expiry_date"],
            type: "string",
        },
    ];

    it("encodes date claims as full-date (tag 1004) and date-time claims as tdate (tag 0)", async () => {
        const claims = {
            birth_date: "1964-08-12",
            issuance_date: "2026-11-20T10:15:30.250+02:00",
            expiry_date: "2026-12-20",
        };

        const issuerSigned = await issue(dateFields, claims);

        const bytes = itemBytes(issuerSigned);
        expect(
            hasTagged(bytes.get("birth_date")!, TAG_1004, "1964-08-12"),
        ).toBe(true);
        // In UTC with whole seconds (ISO/IEC 18013-5 tdate).
        expect(
            hasTagged(
                bytes.get("issuance_date")!,
                TAG_0,
                "2026-11-20T08:15:30Z",
            ),
        ).toBe(true);
        // Without a format, the value stays a text string as before.
        expect(
            hasTagged(bytes.get("expiry_date")!, TAG_1004, "2026-12-20"),
        ).toBe(false);
        const pretty = issuerSigned.getPrettyClaims(NAMESPACE)!;
        expect(pretty.birth_date).toBeInstanceOf(DateOnly);
        expect(pretty.issuance_date).toBeInstanceOf(Date);
        expect(pretty.expiry_date).toBe("2026-12-20");
        // The caller's claims are not changed.
        expect(claims.birth_date).toBe("1964-08-12");
    });

    it("encodes field defaults grouped by namespace", async () => {
        const issuerSigned = await issue(dateFields, {});

        expect(
            hasTagged(
                itemBytes(issuerSigned).get("birth_date")!,
                TAG_1004,
                "1964-08-12",
            ),
        ).toBe(true);
    });

    it("encodes nested and array date claims", async () => {
        const issuerSigned = await issue(
            [
                {
                    namespace: NAMESPACE,
                    path: ["dates"],
                    type: "array",
                    children: [
                        { path: [null], type: "string", format: "date" },
                    ],
                },
            ],
            { dates: ["2001-02-03", "2004-05-06"] },
        );

        const bytes = itemBytes(issuerSigned).get("dates")!;
        expect(hasTagged(bytes, TAG_1004, "2001-02-03")).toBe(true);
        expect(hasTagged(bytes, TAG_1004, "2004-05-06")).toBe(true);
    });

    it("refuses a date claim that is not a calendar date as invalid claims, naming only the path", async () => {
        const result = issue(dateFields, { birth_date: "1964-02-30" });

        await expect(result).rejects.toBeInstanceOf(InvalidCredentialClaims);
        await expect(result).rejects.toThrow(
            'Claim /birth_date must match format "date"',
        );
    });

    it("refuses a stored default that is not a calendar date", async () => {
        const result = issue(
            [
                {
                    namespace: NAMESPACE,
                    path: ["birth_date"],
                    type: "string",
                    format: "date",
                    defaultValue: "1964-02-30",
                },
            ],
            { family_name: "MUSTERMANN" },
        );

        await expect(result).rejects.toBeInstanceOf(InvalidCredentialClaims);
        await expect(result).rejects.toThrow(
            'Claim /birth_date must match format "date"',
        );
    });

    it("refuses a date-time whose UTC year has no four-digit tdate", async () => {
        // Year 0000 at +01:00 is year -1 in UTC.
        const result = issue(dateFields, {
            issuance_date: "0000-01-01T00:30:00+01:00",
        });

        await expect(result).rejects.toBeInstanceOf(InvalidCredentialClaims);
        await expect(result).rejects.toThrow(
            'Claim /issuance_date must match format "date-time"',
        );
    });
});
