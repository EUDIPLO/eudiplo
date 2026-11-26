import type { SecretReference } from "@eudiplo/config-format/config-values.js";
import { describe, expect, it } from "vitest";
import type { SecretSource } from "../../src/platform/secrets/ports/secret-source.js";
import { reference } from "./secret-test-sources.js";

export interface SecretSourceContractSetup {
    source: SecretSource;
    /** A reference the source holds, with its value. */
    present: { reference: string; value: string };
    /** A reference the source answers it does not hold. */
    missing: string;
    /** Grant patterns of the source, valid for the instance. */
    patterns: string[];
    /**
     * References of the source to check the patterns against; none names
     * something the source refuses (such as a setting of EUDIPLO).
     */
    references: string[];
}

const FOREIGN: Record<string, string> = {
    env: "${vault:kv/app#token}",
    vault: "${env:APP_TOKEN}",
};

/**
 * What every SecretSource promises, and what SecretPolicy relies on to keep
 * tenants apart: run it from the spec of each adapter.
 */
export function secretSourceContract(
    name: string,
    setup: () => SecretSourceContractSetup,
): void {
    describe(`${name} (SecretSource contract)`, () => {
        const signal = () => new AbortController().signal;

        it("reads a value it holds and answers undefined for one it does not", async () => {
            const { source, present, missing } = setup();
            const value = await source.read(
                reference(present.reference),
                signal(),
            );
            expect(value?.reveal()).toBe(present.value);
            expect(
                await source.read(reference(missing), signal()),
            ).toBeUndefined();
        });

        it("accepts its patterns for the instance", () => {
            const { source, patterns } = setup();
            for (const pattern of patterns)
                expect(
                    source.validatePattern(pattern, "instance"),
                    pattern,
                ).toBe(undefined);
        });

        it("never places a reference of another source inside a pattern", () => {
            const { source, patterns } = setup();
            const foreign = reference(FOREIGN[source.type]);
            for (const pattern of patterns)
                for (const scope of ["tenant", "instance"] as const)
                    expect(
                        source.within(foreign, pattern, scope),
                        pattern,
                    ).toBe(false);
        });

        it("keeps contains, overlaps and within consistent", () => {
            const { source, patterns, references } = setup();
            const refs: SecretReference[] = references.map(reference);
            for (const outer of patterns) {
                expect(source.contains(outer, outer), outer).toBe(true);
                for (const inner of patterns) {
                    const pair = `${outer} ${inner}`;
                    expect(source.overlaps(outer, inner), pair).toBe(
                        source.overlaps(inner, outer),
                    );
                    if (!source.contains(outer, inner)) continue;
                    expect(source.overlaps(outer, inner), pair).toBe(true);
                    for (const ref of refs)
                        for (const scope of ["tenant", "instance"] as const)
                            if (source.within(ref, inner, scope))
                                expect(
                                    source.within(ref, outer, scope),
                                    `${ref.reference} in ${pair}`,
                                ).toBe(true);
                }
                // A reference inside two patterns means they overlap.
                for (const other of patterns)
                    for (const ref of refs)
                        if (
                            source.within(ref, outer, "instance") &&
                            source.within(ref, other, "instance")
                        )
                            expect(
                                source.overlaps(outer, other),
                                `${ref.reference} in ${outer} and ${other}`,
                            ).toBe(true);
            }
        });
    });
}
