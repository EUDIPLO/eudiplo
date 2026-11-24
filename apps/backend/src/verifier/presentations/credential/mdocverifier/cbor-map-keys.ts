import type { DeviceResponse } from "@owf/mdoc";

/**
 * Nesting the walk follows before it refuses the input. A DeviceResponse
 * stays far below this; the limit keeps the recursion bounded.
 */
const MAX_DEPTH = 128;

/** Tag for a byte string that holds an encoded CBOR data item (RFC 8949 3.4.5.1). */
const ENCODED_CBOR_TAG = 24n;

/**
 * Encoded length up to which an array, a map or a tagged value is accepted as
 * a map key. No mDOC or COSE structure has such keys.
 */
const MAX_ENCODED_KEY_LENGTH = 1024;

/** Characters of a repeated key that go into the error message. */
const MAX_KEY_LABEL_LENGTH = 32;

const BREAK = Symbol("break");

/**
 * Encoded CBOR that is refused before verification: a map repeats a key, or
 * the bytes are not well-formed CBOR, nested too deeply or have a map key too
 * long to check.
 */
export class MalformedCborError extends Error {
    override readonly name = "MalformedCborError";
}

const MajorType = {
    UnsignedInteger: 0,
    NegativeInteger: 1,
    ByteString: 2,
    TextString: 3,
    Array: 4,
    Map: 5,
    Tag: 6,
    Simple: 7,
} as const;

/** What the walk learns about one data item. */
interface Item {
    /** Identity as a map key; unset when the encoded bytes are the identity. */
    key?: string;
    /** Content of a definite-length byte string. */
    byteString?: Uint8Array;
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const shortened = (text: string) =>
    text.length > MAX_KEY_LABEL_LENGTH
        ? `${text.slice(0, MAX_KEY_LABEL_LENGTH)}…`
        : text;

/**
 * Walks encoded CBOR without building values, so that a map which repeats a
 * key is seen. The decoder under `@owf/cose` keeps the last entry of such a
 * map and drops the others.
 */
class CborMapKeyWalker {
    private offset = 0;
    private readonly text = new TextDecoder("utf-8", {
        fatal: true,
        // A leading U+FEFF is part of the key.
        ignoreBOM: true,
    });

    constructor(
        private readonly bytes: Uint8Array,
        private readonly where: string,
        private readonly depth: number,
    ) {}

    /** Checks the single data item the bytes start with. */
    walk(): void {
        if (this.item(this.depth) === BREAK) {
            throw this.malformed();
        }
    }

    private malformed(): Error {
        return new MalformedCborError(`${this.where} is not well-formed CBOR`);
    }

    private take(length: number): Uint8Array {
        if (length > this.bytes.length - this.offset) {
            throw this.malformed();
        }
        const taken = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return taken;
    }

    /** The argument of an item head, `undefined` for an indefinite length. */
    private argument(additionalInfo: number): bigint | undefined {
        if (additionalInfo < 24) {
            return BigInt(additionalInfo);
        }
        if (additionalInfo === 31) {
            return undefined;
        }
        if (additionalInfo > 27) {
            throw this.malformed();
        }
        let value = 0n;
        for (const byte of this.take(1 << (additionalInfo - 24))) {
            value = (value << 8n) | BigInt(byte);
        }
        return value;
    }

    private length(argument: bigint): number {
        if (argument > BigInt(this.bytes.length - this.offset)) {
            throw this.malformed();
        }
        return Number(argument);
    }

    private item(depth: number): Item | typeof BREAK {
        if (depth > MAX_DEPTH) {
            throw new MalformedCborError(`${this.where} is nested too deeply`);
        }
        const [initialByte] = this.take(1);
        const majorType = initialByte >> 5;
        const additionalInfo = initialByte & 0x1f;

        if (majorType === MajorType.Simple) {
            if (additionalInfo === 31) {
                return BREAK;
            }
            if (additionalInfo >= 25 && additionalInfo <= 27) {
                return { key: this.float(additionalInfo) };
            }
            // Simple values: the encoded bytes are the identity.
            const simple = this.argument(additionalInfo);
            if (additionalInfo === 24 && simple !== undefined && simple < 32n) {
                // Has a one-byte encoding, which is the only valid one.
                throw this.malformed();
            }
            return {};
        }

        const argument = this.argument(additionalInfo);
        switch (majorType) {
            case MajorType.UnsignedInteger:
            case MajorType.NegativeInteger:
                if (argument === undefined) {
                    throw this.malformed();
                }
                // By value: 1 is the same key in every encoding of it.
                return {
                    key: `i:${majorType === MajorType.UnsignedInteger ? argument : -1n - argument}`,
                };
            case MajorType.ByteString:
            case MajorType.TextString:
                return this.string(majorType, argument);
            case MajorType.Array:
                this.entries(argument, depth, false);
                return {};
            case MajorType.Map:
                this.entries(argument, depth, true);
                return {};
            default:
                return this.tagged(argument, depth);
        }
    }

    /**
     * A float as a map key, by value: the decoder reads 1.0 in any width as
     * the number 1, the same entry as the integer 1.
     */
    private float(additionalInfo: number): string {
        const bytes = this.take(1 << (additionalInfo - 24));
        const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
        );
        let value: number;
        if (additionalInfo === 27) {
            value = view.getFloat64(0);
        } else if (additionalInfo === 26) {
            value = view.getFloat32(0);
        } else {
            const half = view.getUint16(0);
            const exponent = (half >> 10) & 0x1f;
            const fraction = half & 0x3ff;
            let magnitude: number;
            if (exponent === 0) {
                magnitude = fraction * 2 ** -24;
            } else if (exponent === 31) {
                magnitude = fraction ? Number.NaN : Number.POSITIVE_INFINITY;
            } else {
                magnitude = (fraction + 1024) * 2 ** (exponent - 25);
            }
            value = half & 0x8000 ? -magnitude : magnitude;
        }
        // -0 is 0 here, as it is for the decoder's map.
        return Number.isInteger(value) ? `i:${BigInt(value)}` : `f:${value}`;
    }

    private string(majorType: number, argument: bigint | undefined): Item {
        let content: Uint8Array;
        if (argument === undefined) {
            // Indefinite length: definite-length chunks of the same type.
            const chunks: Uint8Array[] = [];
            for (;;) {
                const [head] = this.take(1);
                if (head === 0xff) {
                    break;
                }
                const chunkLength = this.argument(head & 0x1f);
                if (head >> 5 !== majorType || chunkLength === undefined) {
                    throw this.malformed();
                }
                chunks.push(this.take(this.length(chunkLength)));
            }
            content = Buffer.concat(chunks);
        } else {
            content = this.take(this.length(argument));
        }

        if (majorType === MajorType.ByteString) {
            return { byteString: content, key: `b:${toHex(content)}` };
        }
        try {
            return { key: `t:${this.text.decode(content)}` };
        } catch {
            throw this.malformed();
        }
    }

    private entries(
        argument: bigint | undefined,
        depth: number,
        isMap: boolean,
    ): void {
        const keys = new Set<string>();
        // A map of n entries is 2n data items.
        const itemsPerEntry = isMap ? 2n : 1n;
        const count =
            argument === undefined ? undefined : argument * itemsPerEntry;
        for (let index = 0n; count === undefined || index < count; index++) {
            const start = this.offset;
            const item = this.item(depth + 1);
            if (item === BREAK) {
                // Ends an indefinite-length container, between entries only.
                if (count !== undefined || (isMap && index % 2n === 1n)) {
                    throw this.malformed();
                }
                return;
            }
            if (!isMap || index % 2n === 1n) {
                continue;
            }
            const key = item.key ?? this.encodedKey(start);
            if (keys.has(key)) {
                throw new MalformedCborError(
                    `${this.where} repeats the map key ${this.label(key)}`,
                );
            }
            keys.add(key);
        }
    }

    /**
     * Identity of an array, map, tagged or simple value as a map key: its
     * encoded bytes. Limited in length, because such a key can hold further
     * maps with such keys, each of which is read again at every level.
     */
    private encodedKey(start: number): string {
        if (this.offset - start > MAX_ENCODED_KEY_LENGTH) {
            throw new MalformedCborError(
                `${this.where} has a map key of more than ${MAX_ENCODED_KEY_LENGTH} bytes`,
            );
        }
        return `x:${toHex(this.bytes.subarray(start, this.offset))}`;
    }

    private label(key: string): string {
        const value = key.slice(2);
        switch (key[0]) {
            case "i":
                return value;
            case "f":
                return value;
            case "b":
                return `h'${shortened(value)}'`;
            case "t":
                return JSON.stringify(shortened(value));
            default:
                return `0x${shortened(value)}`;
        }
    }

    private tagged(argument: bigint | undefined, depth: number): Item {
        if (argument === undefined) {
            throw this.malformed();
        }
        const content = this.item(depth + 1);
        if (content === BREAK) {
            throw this.malformed();
        }
        if (argument === ENCODED_CBOR_TAG && content.byteString) {
            new CborMapKeyWalker(
                content.byteString,
                this.where,
                depth + 1,
            ).walk();
        }
        return {};
    }
}

/**
 * Refuses encoded CBOR in which a map repeats a key, at any depth and inside
 * byte strings tagged as encoded CBOR (tag 24).
 *
 * Such a map is not valid CBOR (RFC 8949 section 5.6), and COSE requires a
 * message whose header map repeats a label to be rejected as malformed
 * (RFC 9052 section 3).
 *
 * @param bytes Encoded CBOR; the first data item is checked
 * @param where Name of the structure for the error message
 */
export function assertUniqueCborMapKeys(
    bytes: Uint8Array,
    where: string,
): void {
    new CborMapKeyWalker(bytes, where, 0).walk();
}

/** A COSE_Sign1 or COSE_Mac0 as `@owf/cose` decodes it. */
interface CoseMessage {
    protectedHeaders: { encodedStructure: Uint8Array };
    payload: Uint8Array | null;
}

function assertUniqueCoseMapKeys(
    message: CoseMessage | undefined,
    where: string,
): void {
    if (!message) {
        return;
    }
    // Both are byte strings without tag 24, which the walk over the
    // DeviceResponse does not open. An empty protected header is a
    // zero-length byte string, not a map.
    const protectedHeaders = message.protectedHeaders.encodedStructure;
    if (protectedHeaders.length > 0) {
        assertUniqueCborMapKeys(protectedHeaders, `${where} protected header`);
    }
    if (message.payload?.length) {
        assertUniqueCborMapKeys(message.payload, `${where} payload`);
    }
}

/**
 * Refuses a DeviceResponse in which a map repeats a key: in the response
 * itself, in the protected headers of `IssuerAuth` and of the device
 * signature or MAC, and in the Mobile Security Object.
 *
 * @param bytes The DeviceResponse as received
 * @param deviceResponse The same DeviceResponse, decoded
 */
export function assertUniqueDeviceResponseMapKeys(
    bytes: Uint8Array,
    deviceResponse: DeviceResponse,
): void {
    assertUniqueCborMapKeys(bytes, "DeviceResponse");
    for (const document of deviceResponse.documents ?? []) {
        assertUniqueCoseMapKeys(document.issuerSigned.issuerAuth, "IssuerAuth");
        const deviceAuth = document.deviceSigned.deviceAuth;
        assertUniqueCoseMapKeys(deviceAuth.deviceSignature, "DeviceSignature");
        assertUniqueCoseMapKeys(deviceAuth.deviceMac, "DeviceMac");
    }
}
