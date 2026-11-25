import { describe, expect, it } from "vitest";
import type { ClaimFieldDefinition } from "../../../../../../../packages/eudiplo-sdk-core/src/config";
import * as sdk from "../../../../../../../packages/eudiplo-sdk-core/src/config/derive";
import * as backend from "../../../../../src/issuer/configuration/credentials/utils/derive.js";

const NS = "eu.europa.ec.eudi.pid.1";

// The Web Client previews with the SDK copy what the backend publishes and
// issues with its own copy, so both must derive the same output.
const CASES: Record<string, ClaimFieldDefinition[]> = {
    "mdoc fields with a namespace": [
        {
            path: ["given_name"],
            namespace: NS,
            type: "string",
            defaultValue: "Erika",
        },
        {
            path: ["age_over_18"],
            namespace: NS,
            type: "boolean",
            mandatory: true,
        },
    ],
    "mdoc object and array parents with children": [
        {
            path: ["place_of_birth"],
            namespace: NS,
            type: "object",
            display: [{ locale: "en", name: "Place of birth" }],
            children: [
                { path: ["locality"], type: "string", defaultValue: "BERLIN" },
                {
                    path: ["country"],
                    type: "string",
                    namespace: "org.example.1",
                    defaultValue: "DE",
                },
            ],
        },
        {
            path: ["nationality"],
            namespace: NS,
            type: "array",
            children: [{ path: [0], type: "string", defaultValue: "DE" }],
        },
        {
            path: ["addresses"],
            namespace: NS,
            type: "array",
            children: [{ path: [null], type: "string" }],
        },
    ],
    "paths that already start with the namespace": [
        {
            path: [NS, "family_name"],
            namespace: NS,
            type: "string",
            defaultValue: "MUSTERMANN",
        },
        {
            path: [NS, "address"],
            namespace: NS,
            type: "object",
            children: [
                {
                    path: ["street"],
                    type: "string",
                    defaultValue: "HEIDESTRASSE",
                },
            ],
        },
        { path: [NS], namespace: NS, type: "string", defaultValue: "dropped" },
    ],
    "namespace taken from the first segment of a nested path": [
        {
            path: [NS, "birth_date"],
            type: "string",
            defaultValue: "1964-08-12",
        },
    ],
    "namespace passed down to grandchildren": [
        {
            path: ["place_of_birth"],
            namespace: NS,
            type: "object",
            children: [
                {
                    path: ["address"],
                    type: "object",
                    children: [
                        {
                            path: ["street"],
                            type: "string",
                            defaultValue: "HEIDESTRASSE",
                        },
                    ],
                },
            ],
        },
    ],
    "children of a parent without a namespace": [
        {
            path: ["address"],
            type: "object",
            children: [
                {
                    path: ["street"],
                    type: "string",
                    defaultValue: "HEIDESTRASSE",
                },
            ],
        },
    ],
    "SD-JWT fields without a namespace": [
        {
            path: ["address"],
            type: "object",
            disclosable: true,
            children: [
                {
                    path: ["locality"],
                    type: "string",
                    defaultValue: "Berlin",
                    disclosable: true,
                },
            ],
        },
        {
            path: ["degrees"],
            type: "array",
            children: [{ path: ["title"], type: "string" }],
        },
        { path: ["odd", 1.5], type: "string" },
        { path: ["neg", -1], type: "string" },
        { path: ["huge", Number.MAX_SAFE_INTEGER + 1], type: "string" },
    ],
};

describe("derive parity with the backend", () => {
    for (const [name, fields] of Object.entries(CASES)) {
        describe(name, () => {
            it("builds the same claims metadata", () => {
                expect(sdk.buildClaimsMetadata(fields)).toEqual(
                    backend.buildClaimsMetadata(fields as never),
                );
            });

            it("builds the same claims by namespace", () => {
                expect(sdk.buildClaimsByNamespace(fields)).toEqual(
                    backend.buildClaimsByNamespace(fields as never),
                );
            });
        });
    }
});
