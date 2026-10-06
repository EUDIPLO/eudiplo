import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigVariables } from "@eudiplo/config-format/config-values.js";
import { describe, expect, it } from "vitest";
import {
    copyBundledDemoConfig,
    createComposeEnv,
} from "../src/services/compose-project.js";

// Since 9.0 the backend rejects outbound URLs that use HTTP or point at
// loopback or private addresses unless OUTBOUND_URL_ALLOW_HTTP or
// OUTBOUND_URL_ALLOW_PRIVATE_NETWORK is set, and an attribute provider or
// webhook endpoint with such a URL stops the tenant import.
describe("generated demo tenant", () => {
    it("keeps the default outbound URL policy in the generated env", () => {
        for (const mode of ["demo", "standard"] as const) {
            expect(createComposeEnv({ mode })).not.toMatch(/^OUTBOUND_URL_/m);
        }
    });

    it("bundles only outbound URLs that the default policy accepts", async () => {
        const directory = await mkdtemp(join(tmpdir(), "eudiplo-demo-"));
        await copyBundledDemoConfig(directory, false);
        const files = (await readdir(directory, { recursive: true })).filter(
            (file) => file.endsWith(".json"),
        );
        expect(files.length).toBeGreaterThan(0);

        const rejected: string[] = [];
        for (const file of files) {
            const document = JSON.parse(
                await readFile(join(directory, file), "utf8"),
            );
            // Placeholders resolve to their defaults, as on a fresh demo.
            const { value } = resolveConfigVariables(document, {});
            for (const url of collectUrls(value)) {
                if (!passesDefaultPolicy(url)) {
                    rejected.push(`${file}: ${url}`);
                }
            }
        }

        expect(rejected).toEqual([]);
    });
});

function collectUrls(value: unknown, key?: string): string[] {
    if (typeof value === "string") {
        return key !== "$schema" && /^https?:\/\//i.test(value) ? [value] : [];
    }
    if (!value || typeof value !== "object") {
        return [];
    }
    return Object.entries(value).flatMap(([childKey, child]) =>
        collectUrls(child, childKey),
    );
}

/**
 * Static part of the backend's check, without its DNS lookup. IP literals are
 * rejected outright: the demo has no reason to name a host by address.
 */
function passesDefaultPolicy(url: string): boolean {
    const { protocol, hostname } = new URL(url);
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
        protocol === "https:" &&
        host !== "localhost" &&
        !host.endsWith(".localhost") &&
        isIP(host) === 0
    );
}
