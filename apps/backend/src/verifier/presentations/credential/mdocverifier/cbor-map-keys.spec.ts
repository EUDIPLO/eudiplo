import { cborEncode } from "@owf/cose";
import {
    CoseKey,
    DeviceKey,
    DeviceRequest,
    DeviceResponse,
    DocRequest,
    Holder,
    Issuer,
    IssuerSigned,
    ItemsRequest,
    SessionTranscript,
    SignatureAlgorithm,
} from "@owf/mdoc";
import * as x509 from "@peculiar/x509";
import { exportJWK } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mdocContext } from "../../mdoc-context.js";
import {
    assertUniqueCborMapKeys,
    assertUniqueDeviceResponseMapKeys,
    MalformedCborError,
} from "./cbor-map-keys.js";
import { MdocverifierService } from "./mdocverifier.service.js";

const hex = (value: string) =>
    new Uint8Array(Buffer.from(value.replaceAll(" ", ""), "hex"));

const check = (encoded: string) => () =>
    assertUniqueCborMapKeys(hex(encoded), "Header");

describe("assertUniqueCborMapKeys", () => {
    it.each([
        ["an empty map", "a0"],
        ["distinct integer labels", "a2 01 26 04 41 01"],
        ["1 and -2, which share their argument", "a2 01 26 21 26"],
        ["the integer 1 and the text 1", "a2 01 26 61 31 26"],
        ["a key that an array repeats", "82 a1 01 26 a1 01 26"],
        ["an indefinite-length map", "bf 01 26 04 41 01 ff"],
        [
            "text keys that differ by a leading U+FEFF",
            "a2 61 61 00 64 ef bb bf 61 00",
        ],
        ["nested maps with the same key", "a1 01 a1 01 26"],
        ["floats, simple values and tags", "a3 01 f9 3e 00 02 f5 03 c1 00"],
        [
            "simple values and distinct floats",
            "a4 f4 00 f5 00 f9 3e 00 00 f9 3f 00 00",
        ],
        [
            "an encoded item whose map differs from the outer one",
            "a2 01 d8 18 43 a1 01 26 02 26",
        ],
    ])("accepts %s", (_name, encoded) => {
        expect(check(encoded)).not.toThrow();
    });

    it.each([
        ["an integer label", "a2 01 26 01 26", "1"],
        ["a label in a longer encoding", "a2 01 26 18 01 26", "1"],
        ["a negative label", "a2 20 26 20 26", "-1"],
        ["a text key", "a2 61 61 01 61 61 02", '"a"'],
        [
            "a text key in an indefinite-length encoding",
            "a2 61 61 01 7f 61 61 ff 02",
            '"a"',
        ],
        ["a byte string key", "a2 41 01 00 41 01 00", "h'01'"],
        [
            "a byte string key in a longer encoding",
            "a2 41 01 00 58 01 01 00",
            "h'01'",
        ],
        ["a tagged key", "a2 c1 00 00 c1 00 00", "0xc100"],
        [
            "an integer label as a half-precision float",
            "a2 01 26 f9 3c 00 26",
            "1",
        ],
        [
            "an integer label as a single-precision float",
            "a2 01 26 fa 3f 80 00 00 26",
            "1",
        ],
        [
            "an integer label as a double-precision float",
            "a2 20 26 fb bf f0 00 00 00 00 00 00 26",
            "-1",
        ],
        ["zero as negative zero", "a2 00 26 f9 80 00 26", "0"],
        ["a float in two widths", "a2 f9 3e 00 00 fa 3f c0 00 00 00", "1.5"],
        ["a simple value", "a2 f6 00 f6 00", "0xf6"],
        [
            "infinity in two widths",
            "a2 f9 7c 00 00 fa 7f 80 00 00 00",
            "Infinity",
        ],
        [
            "a subnormal half-precision float in a wider encoding",
            "a2 f9 00 01 00 fa 33 80 00 00 00",
            "5.960464477539063e-8",
        ],
        ["a key in an indefinite-length map", "bf 01 26 01 26 ff", "1"],
        ["a key in a nested map", "a1 04 a2 02 00 02 01", "2"],
        ["a key in an array element", "81 a2 01 26 01 26", "1"],
        ["a key below a tag", "c1 a2 01 26 01 26", "1"],
        [
            "a key in an indefinite-length byte string tagged as encoded CBOR",
            "d8 18 5f 42 a2 01 43 26 01 26 ff",
            "1",
        ],
        [
            "a key in a byte string tagged as encoded CBOR",
            "d8 18 45 a2 01 26 01 26",
            "1",
        ],
    ])("refuses a map that repeats %s", (_name, encoded, key) => {
        expect(check(encoded)).toThrow(`Header repeats the map key ${key}`);
    });

    it("names a long key by its start only", () => {
        const key = cborEncode("k".repeat(100));
        const map = Buffer.concat([hex("a2"), key, hex("00"), key, hex("00")]);

        expect(() => assertUniqueCborMapKeys(map, "Header")).toThrow(
            `Header repeats the map key "${"k".repeat(32)}…"`,
        );
    });

    it.each([
        ["no data", ""],
        ["a map that ends early", "a2 01 26"],
        ["a string longer than the input", "a1 01 58 ff 00"],
        ["a reserved additional information value", "a1 01 1c"],
        ["a break outside an indefinite-length item", "ff"],
        ["a break in place of a map value", "bf 01 ff"],
        [
            "an indefinite-length string with a chunk of another type",
            "5f 61 61 ff",
        ],
        ["text that is not UTF-8", "a1 61 ff 00"],
        ["an integer of indefinite length", "1f"],
        ["a simple value below 32 in two bytes", "f8 14"],
        ["a break in an array of definite length", "81 ff"],
        ["a tag of indefinite length", "df"],
        ["a break as the content of a tag", "c1 ff"],
        [
            "an indefinite-length string in an indefinite-length string",
            "5f 5f ff ff",
        ],
        [
            "a truncated item in a byte string tagged as encoded CBOR",
            "d8 18 41 a1",
        ],
    ])("refuses %s", (_name, encoded) => {
        expect(check(encoded)).toThrow("Header is not well-formed CBOR");
    });

    it("counts byte strings tagged as encoded CBOR towards the nesting limit", () => {
        let nested: Uint8Array = hex("00");
        for (let level = 0; level < 130; level++) {
            nested = Buffer.concat([hex("d8 18"), cborEncode(nested)]);
        }

        expect(() => assertUniqueCborMapKeys(nested, "Header")).toThrow(
            "Header is nested too deeply",
        );
    });

    it("accepts an array as a map key up to 1024 bytes and refuses a longer one", () => {
        const mapWithKey = (keyLength: number) =>
            Buffer.concat([
                hex("a1"),
                // An array of one byte string: 1 + 3 bytes of heads.
                hex("81"),
                cborEncode(new Uint8Array(keyLength - 4)),
                hex("00"),
            ]);

        expect(() =>
            assertUniqueCborMapKeys(mapWithKey(1024), "Header"),
        ).not.toThrow();
        expect(() =>
            assertUniqueCborMapKeys(mapWithKey(1025), "Header"),
        ).toThrow("Header has a map key of more than 1024 bytes");
    });

    it("throws an error the verifier recognizes by its type", () => {
        expect(check("a2 01 26 01 26")).toThrow(MalformedCborError);
        expect(check("a2 01 26")).toThrow(MalformedCborError);
    });

    it("accepts 128 levels of nesting and refuses 129", () => {
        const nested = (levels: number) =>
            Buffer.concat([Buffer.alloc(levels, 0x81), hex("00")]);

        expect(() =>
            assertUniqueCborMapKeys(nested(128), "Header"),
        ).not.toThrow();
        expect(() => assertUniqueCborMapKeys(nested(129), "Header")).toThrow(
            "Header is nested too deeply",
        );
    });

    it("checks the first data item and leaves bytes after it alone", () => {
        expect(check("a1 01 26 a2 01 26 01 26")).not.toThrow();
    });
});

describe("MdocverifierService with a map that repeats a key", () => {
    const docType = "eu.europa.ec.eudi.pid.1";
    const namespace = "eu.europa.ec.eudi.pid.1";
    const algorithm = { name: "ECDSA", namedCurve: "P-256" };

    let issuerKeys: CryptoKeyPair;
    let vp: Uint8Array;
    let sessionTranscript: SessionTranscript;

    beforeAll(async () => {
        x509.cryptoProvider.set(crypto);

        issuerKeys = await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]);
        const certificate =
            await x509.X509CertificateGenerator.createSelfSigned({
                serialNumber: "01",
                name: "C=DE, CN=Self-signed Wallet Issuer",
                notBefore: new Date(Date.now() - 60_000),
                notAfter: new Date(Date.now() + 24 * 3_600_000),
                signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
                keys: issuerKeys,
            });
        const deviceKeys = await crypto.subtle.generateKey(algorithm, true, [
            "sign",
            "verify",
        ]);
        const deviceJwk = (await exportJWK(deviceKeys.privateKey)) as Record<
            string,
            unknown
        >;

        const issuer = new Issuer(docType, mdocContext);
        issuer.addIssuerNamespace(namespace, { given_name: "Erika" });
        const now = new Date();
        const issuerSigned = await issuer.sign({
            signingKey: CoseKey.fromJwk(
                (await exportJWK(issuerKeys.privateKey)) as Record<
                    string,
                    unknown
                >,
            ),
            certificates: [new Uint8Array(certificate.rawData)],
            algorithm: SignatureAlgorithm.ES256,
            digestAlgorithm: "SHA-256",
            deviceKeyInfo: { deviceKey: DeviceKey.fromJwk(deviceJwk) },
            validityInfo: {
                signed: now,
                validFrom: now,
                validUntil: new Date(now.getTime() + 3_600_000),
            },
        });

        sessionTranscript = await SessionTranscript.forOid4Vp(
            {
                clientId: "x509_san_dns:eudiplo.example",
                responseUri: "https://eudiplo.example/response",
                nonce: "nonce",
            },
            mdocContext,
        );
        const deviceResponse =
            await Holder.createDeviceResponseForDeviceRequest(
                {
                    deviceRequest: DeviceRequest.create({
                        docRequests: [
                            DocRequest.create({
                                itemsRequest: ItemsRequest.create({
                                    docType,
                                    namespaces: {
                                        [namespace]: { given_name: true },
                                    },
                                }),
                            }),
                        ],
                    }),
                    sessionTranscript,
                    documents: [
                        {
                            docRequestIndex: 0,
                            issuerSigned: IssuerSigned.fromEncodedForOid4Vci(
                                issuerSigned.encodedForOid4Vci,
                            ),
                            signature: {
                                signingKey: CoseKey.fromJwk({
                                    ...deviceJwk,
                                    alg: "ES256",
                                }),
                                algorithm: SignatureAlgorithm.ES256,
                            },
                        },
                    ],
                },
                mdocContext,
            );
        vp = new Uint8Array(
            Buffer.from(deviceResponse.encodedForOid4Vp, "base64url"),
        );
    });

    /** The byte string `content` as it is encoded in `vp`. */
    const byteString = (content: Uint8Array) => {
        const encoded = cborEncode(content);
        const start = Buffer.from(vp).indexOf(encoded);
        expect(start).toBeGreaterThan(-1);
        return { start, end: start + encoded.length };
    };

    const replaced = (
        source: Uint8Array,
        { start, end }: { start: number; end: number },
        replacement: Uint8Array,
    ) =>
        Buffer.concat([
            source.subarray(0, start),
            replacement,
            source.subarray(end),
        ]);

    const issuerAuthOf = (presentation: Uint8Array) => {
        const issuerAuth =
            DeviceResponse.decode(presentation).documents?.[0].issuerSigned
                .issuerAuth;
        if (!issuerAuth?.payload) {
            throw new Error("IssuerAuth without payload");
        }
        return { issuerAuth, payload: issuerAuth.payload };
    };

    /**
     * The presentation with `protectedHeader` as the protected header of
     * `IssuerAuth` and `payload` as its payload, signed by the issuer over
     * exactly these bytes.
     */
    async function withIssuerAuth({
        protectedHeader = hex("a1 01 26"),
        payload,
    }: {
        protectedHeader?: Uint8Array;
        payload?: Uint8Array;
    }) {
        const { issuerAuth, payload: originalPayload } = issuerAuthOf(vp);
        const signedPayload = payload ?? originalPayload;
        const signature = new Uint8Array(
            await crypto.subtle.sign(
                { name: "ECDSA", hash: "SHA-256" },
                issuerKeys.privateKey,
                cborEncode([
                    "Signature1",
                    protectedHeader,
                    new Uint8Array(),
                    signedPayload,
                ]),
            ),
        );

        // Header, payload, signature: replaced from the end, so that the
        // positions before a replacement stay.
        const signaturePosition = byteString(issuerAuth.signature);
        const payloadPosition = byteString(originalPayload);
        const headerPosition = byteString(
            issuerAuth.protectedHeaders.encodedStructure,
        );
        expect(headerPosition.end).toBeLessThanOrEqual(payloadPosition.start);
        expect(payloadPosition.end).toBeLessThanOrEqual(
            signaturePosition.start,
        );
        return replaced(
            replaced(
                replaced(vp, signaturePosition, cborEncode(signature)),
                payloadPosition,
                cborEncode(signedPayload),
            ),
            headerPosition,
            cborEncode(protectedHeader),
        );
    }

    /** `map`, encoded, with its first entry a second time. */
    const withFirstEntryRepeated = (map: Uint8Array, entry: Uint8Array) => {
        // A map of fewer than 23 entries: the count is in the first byte.
        expect(map[0] >> 5).toBe(5);
        expect(map[0] & 0x1f).toBeLessThan(23);
        expect(Buffer.from(map).indexOf(entry)).toBe(1);
        return Buffer.concat([
            new Uint8Array([map[0] + 1]),
            entry,
            map.subarray(1),
        ]);
    };

    const versionEntry = cborEncode(new Map([["version", "1.0"]])).subarray(1);

    const newService = () => {
        const logger = {
            setContext: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };
        const chainValidation = {
            getTrustedCertificateEntries: vi.fn().mockResolvedValue([]),
            validateChain: vi.fn().mockResolvedValue({
                verified: true,
                pidIssuer: false,
                matchedEntity: null,
            }),
            discardedTrustListsDetail: vi.fn().mockResolvedValue(undefined),
        };
        return new MdocverifierService(
            chainValidation as never,
            { mdocFetch: vi.fn() } as never,
            logger as never,
        );
    };

    const verify = (presentation: Uint8Array) => {
        return newService().verify(
            Buffer.from(presentation).toString("base64url"),
            { protocol: "iso-18013-7", sessionTranscript },
            {
                trustListSource: { lotes: [], tenantId: "tenant-a" },
                policy: { revocation: { enabled: false } },
            } as never,
            [[namespace, "given_name"]],
        );
    };

    it("accepts the presentation as the wallet built it", async () => {
        const result = await verify(vp);

        expect(result).toMatchObject({
            verified: true,
            claims: { given_name: "Erika" },
        });
    });

    it("accepts an IssuerAuth that the issuer signed again with the same protected header", async () => {
        const result = await verify(await withIssuerAuth({}));

        expect(result).toMatchObject({ verified: true });
    });

    it("refuses an IssuerAuth whose protected header repeats alg, although the signature covers it", async () => {
        const result = await verify(
            await withIssuerAuth({ protectedHeader: hex("a2 01 26 01 26") }),
        );

        expect(result).toMatchObject({
            verified: false,
            failureType: "verification_error",
            failureReason: "IssuerAuth protected header repeats the map key 1",
        });
        expect(result.claims).toEqual({});
    });

    it("refuses a DeviceSignature whose protected header repeats alg as a verification error, not as an invalid signature", async () => {
        const deviceSignature =
            DeviceResponse.decode(vp).documents?.[0].deviceSigned.deviceAuth
                .deviceSignature;
        if (!deviceSignature) {
            throw new Error("Presentation without DeviceSignature");
        }
        const header = cborEncode(
            deviceSignature.protectedHeaders.encodedStructure,
        );
        // IssuerAuth comes first and has the same protected header.
        const start = Buffer.from(vp).lastIndexOf(header);
        expect(start).toBeGreaterThan(Buffer.from(vp).indexOf(header));

        const result = await verify(
            replaced(
                vp,
                { start, end: start + header.length },
                cborEncode(hex("a2 01 26 01 26")),
            ),
        );

        expect(result).toMatchObject({
            verified: false,
            failureType: "verification_error",
            failureReason:
                "DeviceSignature protected header repeats the map key 1",
        });
    });

    it("refuses a Mobile Security Object that repeats a key, although the signature covers it", async () => {
        // The payload is the MSO as a byte string tagged as encoded CBOR.
        const { payload } = issuerAuthOf(vp);
        expect(Buffer.from(payload.subarray(0, 2)).toString("hex")).toBe(
            "d818",
        );
        const taggedLength = payload[2] === 0x59 ? 3 : 2;
        expect([0x58, 0x59]).toContain(payload[2]);
        const mso = payload.subarray(2 + taggedLength);
        const repeated = Buffer.concat([
            hex("d8 18"),
            cborEncode(withFirstEntryRepeated(mso, versionEntry)),
        ]);

        const result = await verify(
            await withIssuerAuth({ payload: repeated }),
        );

        expect(result).toMatchObject({
            verified: false,
            failureType: "verification_error",
            failureReason: 'IssuerAuth payload repeats the map key "version"',
        });
        expect(result.claims).toEqual({});
    });

    it("refuses a DeviceMac whose protected header repeats a label", () => {
        const { issuerAuth } = issuerAuthOf(vp);

        expect(() =>
            assertUniqueDeviceResponseMapKeys(vp, {
                documents: [
                    {
                        issuerSigned: { issuerAuth },
                        deviceSigned: {
                            deviceAuth: {
                                deviceMac: {
                                    protectedHeaders: {
                                        encodedStructure: hex("a2 01 05 01 05"),
                                    },
                                    payload: null,
                                },
                            },
                        },
                    },
                ],
            } as never),
        ).toThrow("DeviceMac protected header repeats the map key 1");
    });

    it("checks every document, and accepts an empty protected header", () => {
        const { issuerAuth } = issuerAuthOf(vp);
        const document = (protectedHeader: Uint8Array) => ({
            issuerSigned: { issuerAuth },
            deviceSigned: {
                deviceAuth: {
                    deviceSignature: {
                        protectedHeaders: { encodedStructure: protectedHeader },
                        payload: null,
                    },
                },
            },
        });
        const check = (second: Uint8Array) => () =>
            assertUniqueDeviceResponseMapKeys(vp, {
                documents: [document(hex("a1 01 26")), document(second)],
            } as never);

        expect(check(new Uint8Array())).not.toThrow();
        expect(check(hex("a2 01 26 01 26"))).toThrow(
            "DeviceSignature protected header repeats the map key 1",
        );
    });

    it("does not let the repeated key decide the failure type", () => {
        // A key the wallet chose, whose words name other failure types.
        const failureType = (newService() as any).classifyVerificationError(
            new MalformedCborError(
                'DeviceResponse repeats the map key "status list signature"',
            ),
        );

        expect(failureType).toBe("verification_error");
    });

    it("refuses a DeviceResponse that repeats a key outside the COSE headers", async () => {
        // `version` a second time: a map of one more entry, the key and
        // value of the first entry again.
        const result = await verify(withFirstEntryRepeated(vp, versionEntry));

        expect(result).toMatchObject({
            verified: false,
            failureType: "verification_error",
            failureReason: 'DeviceResponse repeats the map key "version"',
        });
        expect(result.claims).toEqual({});
    });
});
