import { describe, expect, it } from "vitest";
import {
    assertImageTag,
    migrationNotes,
    planImageUpgrade,
} from "../src/services/compose-upgrade.js";

const envFile = [
    "# managed by eudiplo init, edit freely",
    "EUDIPLO_ENV_FILE=.eudiplo.env",
    "EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo:8.0.2",
    "EUDIPLO_CLIENT_IMAGE=ghcr.io/openwallet-foundation/eudiplo-client:8.0.2",
    "PUBLIC_URL=https://eudiplo.example.com",
    "",
    "# my own settings",
    "MY_FEATURE_FLAG=on",
    "LOG_LEVEL=debug",
    "",
].join("\n");

describe("image upgrade planning", () => {
    it("changes only the managed image tags", () => {
        const plan = planImageUpgrade(envFile, "8.1.0");

        expect(plan.changes).toEqual([
            {
                key: "EUDIPLO_IMAGE",
                repository: "ghcr.io/openwallet-foundation/eudiplo",
                from: "8.0.2",
                to: "8.1.0",
            },
            {
                key: "EUDIPLO_CLIENT_IMAGE",
                repository: "ghcr.io/openwallet-foundation/eudiplo-client",
                from: "8.0.2",
                to: "8.1.0",
            },
        ]);
        expect(plan.content).toBe(envFile.replaceAll(":8.0.2", ":8.1.0"));
    });

    it("preserves every user-managed line byte for byte", () => {
        const before = envFile.split("\n");
        const after = planImageUpgrade(envFile, "9.0.0").content.split("\n");

        expect(after).toHaveLength(before.length);
        before.forEach((line, index) => {
            if (
                !line.startsWith("EUDIPLO_IMAGE=") &&
                !line.startsWith("EUDIPLO_CLIENT_IMAGE=")
            ) {
                expect(after[index]).toBe(line);
            }
        });
    });

    it("keeps CRLF line endings", () => {
        const crlf = envFile.replaceAll("\n", "\r\n");
        const plan = planImageUpgrade(crlf, "8.1.0");

        expect(plan.content).toBe(crlf.replaceAll(":8.0.2", ":8.1.0"));
    });

    it("reports no changes when already on the tag", () => {
        const plan = planImageUpgrade(envFile, "8.0.2");

        expect(plan.changes).toEqual([]);
        expect(plan.content).toBe(envFile);
    });

    it("upgrades an instance without the web client", () => {
        const noClient = envFile
            .split("\n")
            .filter((line) => !line.startsWith("EUDIPLO_CLIENT_IMAGE="))
            .join("\n");

        expect(planImageUpgrade(noClient, "8.1.0").changes).toHaveLength(1);
    });

    it.each([
        [
            "a custom registry",
            "EUDIPLO_IMAGE=registry.example.com/eudiplo:8.0.2",
        ],
        [
            "a digest",
            "EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo@sha256:abc123",
        ],
        ["no tag", "EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo"],
    ])("refuses a user-managed image line with %s", (_label, line) => {
        const custom = envFile.replace(
            "EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo:8.0.2",
            line,
        );

        expect(() => planImageUpgrade(custom, "8.1.0")).toThrow(
            /not a CLI-managed image/,
        );
    });

    it("refuses when no managed image is defined", () => {
        expect(() => planImageUpgrade("PUBLIC_URL=x\n", "8.1.0")).toThrow(
            /does not define EUDIPLO_IMAGE/,
        );
    });

    it("refuses duplicate managed keys instead of picking one", () => {
        const duplicated = `${envFile}EUDIPLO_IMAGE=ghcr.io/openwallet-foundation/eudiplo:7.0.0\n`;

        expect(() => planImageUpgrade(duplicated, "8.1.0")).toThrow(
            /defined more than once/,
        );
    });

    it("ignores commented-out and prefixed keys", () => {
        const withComment = `${envFile}# EUDIPLO_IMAGE=old\nMY_EUDIPLO_IMAGE=keep\n`;
        const plan = planImageUpgrade(withComment, "8.1.0");

        expect(plan.content).toContain(
            "# EUDIPLO_IMAGE=old\nMY_EUDIPLO_IMAGE=keep\n",
        );
    });

    it.each(["latest", "8.1.0", "v8.1.0", "8.1.0-rc.1", "main_2026"])(
        "accepts tag %s",
        (tag) => {
            expect(() => assertImageTag(tag)).not.toThrow();
        },
    );

    it.each(["", "-rm", ".hidden", "8.1.0 && rm", "a/b", "x".repeat(129)])(
        "rejects tag %j",
        (tag) => {
            expect(() => assertImageTag(tag)).toThrow(/Invalid image tag/);
        },
    );
});

describe("migration notes", () => {
    it("has nothing to say for a minor or patch upgrade", () => {
        expect(migrationNotes("8.0.2", "8.1.0")).toEqual([]);
    });

    it("links the guide for every major version crossed", () => {
        expect(migrationNotes("6.2.0", "8.0.0")).toEqual([
            "Major version 7: read https://docs.eudiplo.dev/upgrade/6.x-to-7.0 first.",
            "Major version 8: read https://docs.eudiplo.dev/upgrade/7.x-to-8.0 first.",
        ]);
    });

    it("warns about downgrades", () => {
        expect(migrationNotes("8.1.0", "8.0.2")[0]).toMatch(/older than 8.1.0/);
    });

    it("points to the guide index for non-version tags", () => {
        expect(migrationNotes("latest", "8.1.0")[0]).toMatch(
            /Cannot compare latest and 8.1.0/,
        );
    });
});
