import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { JwksKeySet } from "./jwks-key-set.js";

function jwk(kid: string | undefined) {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return {
        ...publicKey.export({ format: "jwk" }),
        ...(kid !== undefined && { kid }),
        use: "sig",
    };
}

function setup(initialKeys: unknown[]) {
    let time = 0;
    let keys = initialKeys;
    const fetcher = vi.fn(async () => ({ keys }));
    const onFetchError = vi.fn();
    const keySet = new JwksKeySet({
        jwksUri: "https://idp.example/jwks",
        fetcher,
        maxAgeMs: 600_000,
        maxStaleMs: 3_600_000,
        cooldownMs: 30_000,
        now: () => time,
        onFetchError,
    });
    return {
        keySet,
        fetcher,
        onFetchError,
        advance: (ms: number) => {
            time += ms;
        },
        setKeys: (next: unknown[]) => {
            keys = next;
        },
    };
}

describe("JwksKeySet", () => {
    it("answers a known kid from the fetched set", async () => {
        const { keySet, fetcher } = setup([jwk("a")]);
        await expect(keySet.getKey("a")).resolves.toContain("BEGIN PUBLIC KEY");
        await keySet.getKey("a");
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("fetches at most once per cooldown for unknown kids", async () => {
        const { keySet, fetcher, advance } = setup([jwk("a")]);
        await keySet.getKey("a");
        for (let i = 0; i < 50; i++) {
            await expect(keySet.getKey(`random-${i}`)).rejects.toThrow(
                /no signing key/,
            );
        }
        expect(fetcher).toHaveBeenCalledTimes(1);
        advance(30_000);
        await expect(keySet.getKey("random-x")).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("keeps answering the real kid while unknown kids are sent, also after the set aged", async () => {
        const { keySet, fetcher, advance } = setup([jwk("a")]);
        await keySet.getKey("a");
        advance(600_000);
        // An unknown kid triggers the refresh the aged set needs anyway.
        await expect(keySet.getKey("random")).rejects.toThrow();
        await expect(keySet.getKey("a")).resolves.toBeDefined();
        advance(10_000);
        await expect(keySet.getKey("random-2")).rejects.toThrow();
        await expect(keySet.getKey("a")).resolves.toBeDefined();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("keeps the last key set when a fetch fails", async () => {
        const { keySet, fetcher, onFetchError, advance } = setup([jwk("a")]);
        await keySet.getKey("a");
        fetcher.mockRejectedValueOnce(new Error("down"));
        advance(600_000);
        await expect(keySet.getKey("a")).resolves.toBeDefined();
        expect(onFetchError).toHaveBeenCalledTimes(1);
    });

    it("refuses every token once the key set could not be read for too long", async () => {
        const { keySet, fetcher, advance } = setup([jwk("a")]);
        await keySet.getKey("a");
        fetcher.mockRejectedValue(new Error("down"));
        advance(3_599_999);
        await expect(keySet.getKey("a")).resolves.toBeDefined();
        advance(1);
        // Within the cooldown of the last failed fetch: no fetch, no key.
        await expect(keySet.getKey("a")).rejects.toThrow(/no signing key/);
        advance(30_000);
        await expect(keySet.getKey("a")).rejects.toThrow("down");
    });

    it("fails when the first fetch fails, and waits for the cooldown before the next", async () => {
        const { keySet, fetcher, onFetchError, advance } = setup([jwk("a")]);
        fetcher.mockRejectedValueOnce(new Error("down"));
        await expect(keySet.getKey("a")).rejects.toThrow("down");
        expect(onFetchError).toHaveBeenCalledTimes(1);
        await expect(keySet.getKey("a")).rejects.toThrow(/no signing key/);
        expect(fetcher).toHaveBeenCalledTimes(1);
        advance(30_000);
        await expect(keySet.getKey("a")).resolves.toBeDefined();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("refuses an unknown kid during an outage and keeps the known one", async () => {
        const { keySet, fetcher, advance } = setup([jwk("a")]);
        await keySet.getKey("a");
        fetcher.mockRejectedValueOnce(new Error("down"));
        advance(600_000);
        await expect(keySet.getKey("x")).rejects.toThrow("down");
        await expect(keySet.getKey("a")).resolves.toBeDefined();
    });

    it("accepts a key without use and keeps the first of two keys with the same kid", async () => {
        const first = { ...jwk("a"), use: undefined };
        const { keySet } = setup([first, jwk("a")]);
        const { createPublicKey } = await import("node:crypto");
        expect(await keySet.getKey("a")).toBe(
            createPublicKey({ key: first as never, format: "jwk" })
                .export({ type: "spki", format: "pem" })
                .toString(),
        );
    });

    it("refuses a response whose keys are not a list", async () => {
        const { keySet, fetcher } = setup([]);
        fetcher.mockResolvedValueOnce({ keys: {} });
        await expect(keySet.getKey("a")).rejects.toThrow(
            /contains no signing keys/,
        );
    });

    it("finds a key the provider added at the first fetch after the cooldown", async () => {
        const { keySet, setKeys, advance } = setup([jwk("a")]);
        await keySet.getKey("a");
        setKeys([jwk("a"), jwk("b")]);
        await expect(keySet.getKey("b")).rejects.toThrow();
        advance(30_000);
        await expect(keySet.getKey("b")).resolves.toBeDefined();
    });

    it("shares one fetch between concurrent requests", async () => {
        const { keySet, fetcher } = setup([jwk("a")]);
        await Promise.all([
            keySet.getKey("a"),
            keySet.getKey("a"),
            keySet.getKey("unknown").catch(() => undefined),
        ]);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("uses the only key for a token without kid and refuses with several", async () => {
        const single = setup([jwk(undefined)]);
        await expect(single.keySet.getKey(undefined)).resolves.toBeDefined();
        const several = setup([jwk("a"), jwk("b")]);
        await expect(several.keySet.getKey(undefined)).rejects.toThrow(
            /names no key/,
        );
    });

    it("skips encryption and unusable keys", async () => {
        const { keySet } = setup([
            { ...jwk("enc"), use: "enc" },
            { kty: "oct", kid: "sym", k: "AAAA" },
            { kty: "RSA", kid: "broken" },
            jwk("a"),
        ]);
        await expect(keySet.getKey("a")).resolves.toBeDefined();
        await expect(keySet.getKey("enc")).rejects.toThrow();
        await expect(keySet.getKey("sym")).rejects.toThrow();
        await expect(keySet.getKey("broken")).rejects.toThrow();
    });

    it("refuses a key set without signing keys", async () => {
        const { keySet } = setup([{ ...jwk("enc"), use: "enc" }]);
        await expect(keySet.getKey("enc")).rejects.toThrow(
            /contains no signing keys/,
        );
    });
});
