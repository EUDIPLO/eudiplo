import { cborDecode, cborEncode, DataItem, DateOnly } from "@owf/cose";
import { describe, expect, it } from "vitest";
import { toJsonClaims } from "./mdoc-claim-json.js";

/** Element values as the mDOC library decodes them from CBOR. */
const decoded = (value: unknown): unknown => cborDecode(cborEncode(value));
const fromHex = (cbor: string): unknown => cborDecode(Buffer.from(cbor, "hex"));

/** What the session stores and returns: the claims after a JSON round trip. */
const stored = (claims: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(toJsonClaims(claims)));

describe("toJsonClaims", () => {
    it("loses a CBOR map without the conversion", () => {
        const placeOfBirth = decoded(
            new Map([
                ["locality", "Berlin"],
                ["country", "DE"],
            ]),
        );

        expect(placeOfBirth).toBeInstanceOf(Map);
        expect(JSON.parse(JSON.stringify({ placeOfBirth }))).toEqual({
            placeOfBirth: {},
        });
    });

    it("converts CBOR maps to objects, also nested and inside arrays", () => {
        const claims = {
            place_of_birth: decoded(
                new Map([
                    ["locality", "Berlin"],
                    ["country", "DE"],
                ]),
            ),
            nested: decoded(
                new Map([
                    ["outer", new Map([["inner", [new Map([["a", 1]])]]])],
                ]),
            ),
            nationalities: decoded(["DE", "FR"]),
        };

        expect(stored(claims)).toEqual({
            place_of_birth: { locality: "Berlin", country: "DE" },
            nested: { outer: { inner: [{ a: 1 }] } },
            nationalities: ["DE", "FR"],
        });
    });

    it("keeps text, integer, boolean and null values", () => {
        expect(
            stored({
                family_name: decoded("Mustermann"),
                age_in_years: decoded(61),
                age_over_18: decoded(true),
                empty: decoded(null),
            }),
        ).toEqual({
            family_name: "Mustermann",
            age_in_years: 61,
            age_over_18: true,
            empty: null,
        });
    });

    it("leaves byte strings, embedded CBOR and typed arrays as bytes", () => {
        const portrait = decoded(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
        expect(portrait).toBeInstanceOf(Uint8Array);
        // Only a top-level tag 24 is unwrapped by the decoder.
        const embedded = decoded([DataItem.fromData("x")]) as unknown[];
        // tag 85 (float32 little endian) [1.5]
        const floats = fromHex("d8554400 00c03f".replaceAll(" ", ""));
        expect(floats).toBeInstanceOf(Float32Array);

        const result = toJsonClaims({
            portrait,
            embedded,
            floats,
            in_map: decoded(new Map([["bytes", new Uint8Array([1, 2])]])),
        });

        expect(result.portrait).toBe(portrait);
        expect(result.embedded).toEqual([(embedded[0] as DataItem).buffer]);
        expect(result.floats).toBe(floats);
        expect(JSON.stringify(result.in_map)).toBe(
            JSON.stringify({ bytes: new Uint8Array([1, 2]) }),
        );
        expect(Buffer.from((embedded[0] as DataItem).buffer)).toEqual(
            Buffer.from(cborEncode("x")),
        );
    });

    it("writes an invalid date as null", () => {
        expect(
            toJsonClaims({
                date: new Date(Number.NaN),
                date_only: new DateOnly("not a date"),
            }),
        ).toEqual({ date: null, date_only: null });
    });

    it("lets the later of two keys with the same text win", () => {
        expect(
            stored({
                map: decoded(
                    new Map<unknown, string>([
                        [1, "a"],
                        ["1", "b"],
                    ]),
                ),
            }),
        ).toEqual({ map: { "1": "b" } });
    });

    it("writes dates as ISO 8601 text", () => {
        expect(
            stored({
                birth_date: decoded(new DateOnly("1964-08-12")),
                issuance_date: decoded(new Date("2026-01-02T03:04:05Z")),
                // tag 1 (epoch seconds) 1600000000
                epoch: fromHex("c11a5f5e1000"),
                in_map: decoded(
                    new Map([["date", new DateOnly("2000-02-29")]]),
                ),
            }),
        ).toEqual({
            birth_date: "1964-08-12",
            issuance_date: "2026-01-02T03:04:05.000Z",
            epoch: "2020-09-13T12:26:40.000Z",
            in_map: { date: "2000-02-29" },
        });
    });

    it("writes 64-bit integers as numbers when safe and as text otherwise", () => {
        // uint64 5, uint64 2^53 + 1, bignum (tag 2) 2^64
        const claims = {
            small: fromHex("1b0000000000000005"),
            large: fromHex("1b0020000000000001"),
            bignum: fromHex("c249010000000000000000"),
            negative: fromHex("3b0020000000000000"),
        };
        expect(typeof claims.small).toBe("bigint");
        expect(() => JSON.stringify(claims)).toThrow(TypeError);

        expect(stored(claims)).toEqual({
            small: 5,
            large: "9007199254740993",
            bignum: "18446744073709551616",
            negative: "-9007199254740993",
        });
    });

    it("writes non-text map keys as text", () => {
        expect(
            stored({
                keys: decoded(
                    new Map<unknown, string>([
                        [1, "int"],
                        [-2, "negative"],
                        [true, "bool"],
                        [new Uint8Array([1, 2, 3]), "bytes"],
                        [[1, 2], "array"],
                    ]),
                ),
            }),
        ).toEqual({
            keys: {
                "1": "int",
                "-2": "negative",
                true: "bool",
                AQID: "bytes",
                "[1,2]": "array",
            },
        });
    });

    it("keeps a __proto__ key as a claim", () => {
        const result = toJsonClaims({
            map: decoded(new Map([["__proto__", "value"]])),
        });

        expect(Object.getPrototypeOf(result.map)).toBe(Object.prototype);
        expect(Object.keys(result.map as object)).toEqual(["__proto__"]);
        expect(JSON.stringify(result)).toBe('{"map":{"__proto__":"value"}}');
    });

    it("writes values JSON has no form for as null", () => {
        expect(
            stored({
                nan: fromHex("f97e00"),
                infinity: fromHex("f97c00"),
                undefined: fromHex("f7"),
            }),
        ).toEqual({ nan: null, infinity: null, undefined: null });
    });

    it("writes sets as arrays and unknown tags with their number", () => {
        expect(
            stored({
                // tag 258 [1, 2]
                set: fromHex("d90102820102"),
                // tag 9999 (map {"a": 1})
                tagged: fromHex("d9270fa1616101"),
            }),
        ).toEqual({ set: [1, 2], tagged: { value: { a: 1 }, tag: 9999 } });
    });

    it("replaces a value that contains itself with null", () => {
        // tag 28 [tag 29 (0)]: an array whose only element is itself
        const cyclic = fromHex("d81c81d81d00");

        expect(stored({ cyclic })).toEqual({ cyclic: [null] });
    });

    it("converts each shared value once, so value sharing cannot blow up", () => {
        // [28([]), 28([29(0), 29(0)]), ..., 28([29(n-2), 29(n-2)])]: without
        // sharing, the last item alone would hold 2^(n-1) arrays.
        const n = 60;
        const uint = (i: number) =>
            i < 24
                ? i.toString(16).padStart(2, "0")
                : `18${i.toString(16).padStart(2, "0")}`;
        let cbor = `98${n.toString(16)}d81c80`;
        for (let k = 1; k < n; k++) {
            cbor += `d81c82d81d${uint(k - 1)}d81d${uint(k - 1)}`;
        }

        const result = toJsonClaims({ dag: fromHex(cbor) });

        const items = result.dag as unknown[];
        expect(items).toHaveLength(n);
        expect(items[1]).toEqual([null, null]);
        expect(JSON.stringify(result).length).toBeLessThan(1000);
    });
});
