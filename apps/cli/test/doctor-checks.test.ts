import { describe, expect, it } from "vitest";
import {
    parseContainerStates,
    summarizeContainerStates,
} from "../src/services/container-state.js";
import {
    formatChecks,
    formatSummary,
    hasFailedChecks,
    runDoctor,
    summarizeChecks,
} from "../src/services/diagnostics.js";
import {
    checkTlsCertificate,
    evaluateCertificate,
    type PeerCertificate,
} from "../src/services/tls-expiry.js";
import type {
    CommandContext,
    DoctorCheck,
    InstanceConfig,
} from "../src/types.js";

const now = new Date("2026-09-27T00:00:00Z");

function certificate(validTo: string): PeerCertificate {
    return {
        subject: "eudiplo.example.com",
        issuer: "Example CA",
        validTo: new Date(validTo),
    };
}

describe("TLS certificate expiry", () => {
    it("passes when the certificate is valid for a while", () => {
        const check = evaluateCertificate(certificate("2027-01-01"), now);
        expect(check.status).toBe("pass");
        expect(check.message).toContain("2027-01-01");
    });

    it("warns inside the renewal window", () => {
        const check = evaluateCertificate(certificate("2026-10-10"), now);
        expect(check.status).toBe("warn");
        expect(check.message).toContain("13 day(s)");
    });

    it("fails once expired", () => {
        const check = evaluateCertificate(certificate("2026-09-01"), now);
        expect(check.status).toBe("fail");
        expect(check.message).toContain("expired on 2026-09-01");
    });

    it("honours a custom warning threshold", () => {
        expect(
            evaluateCertificate(certificate("2026-11-15"), now, 90).status,
        ).toBe("warn");
    });

    it("skips plain HTTP instead of failing", async () => {
        const check = await checkTlsCertificate(
            new URL("http://localhost:3000"),
            now,
            async () => certificate("2027-01-01"),
        );
        expect(check.status).toBe("skip");
    });

    it("fails, without disabling verification, when the handshake fails", async () => {
        const check = await checkTlsCertificate(
            new URL("https://eudiplo.example.com"),
            now,
            async () => {
                throw new Error("self-signed certificate");
            },
        );
        expect(check.status).toBe("fail");
        expect(check.message).toContain("self-signed certificate");
    });
});

describe("container state parsing", () => {
    it("reads the Docker format: one JSON object per line", () => {
        const stdout = [
            '{"Names":"eudiplo-eudiplo-1","State":"running","Status":"Up 2 minutes (healthy)"}',
            '{"Names":"eudiplo-eudiplo-client-1","State":"running","Status":"Up 2 minutes"}',
        ].join("\n");

        expect(parseContainerStates(stdout)).toEqual([
            {
                name: "eudiplo-eudiplo-1",
                state: "running",
                status: "Up 2 minutes (healthy)",
            },
            {
                name: "eudiplo-eudiplo-client-1",
                state: "running",
                status: "Up 2 minutes",
            },
        ]);
    });

    it("reads the Podman format: an array with Names as a list", () => {
        const stdout = JSON.stringify([
            {
                Names: ["eudiplo_eudiplo_1"],
                State: "running",
                Status: "Up 5 minutes (starting)",
            },
        ]);

        expect(parseContainerStates(stdout)).toEqual([
            {
                name: "eudiplo_eudiplo_1",
                state: "running",
                status: "Up 5 minutes (starting)",
            },
        ]);
    });

    it("treats empty output as no containers", () => {
        expect(parseContainerStates("  \n")).toEqual([]);
    });

    it("reads the exit code from Docker's status and Podman's ExitCode", () => {
        const [docker, killed, running] = parseContainerStates(
            [
                '{"Names":"a","State":"exited","Status":"Exited (0) 3 minutes ago"}',
                '{"Names":"b","State":"exited","Status":"Exited (137) 1 minute ago"}',
                '{"Names":"c","State":"running","Status":"Up 1 minute"}',
            ].join("\n"),
        );
        const [podman] = parseContainerStates(
            JSON.stringify([
                { Names: ["d"], State: "exited", Status: "", ExitCode: 0 },
            ]),
        );

        expect(docker.exitCode).toBe(0);
        expect(killed.exitCode).toBe(137);
        expect(running.exitCode).toBeUndefined();
        expect(podman.exitCode).toBe(0);
    });

    it("counts a container that exited with 0 as completed, not as stopped", () => {
        // The standard preset creates the RustFS bucket in a one-shot
        // container that stays behind as "Exited (0)".
        const check = summarizeContainerStates(
            parseContainerStates(
                [
                    '{"Names":"eudiplo-eudiplo-1","State":"running","Status":"Up 2 minutes (healthy)"}',
                    '{"Names":"eudiplo-rustfs-1","State":"running","Status":"Up 2 minutes (healthy)"}',
                    '{"Names":"eudiplo-rustfs-init-1","State":"exited","Status":"Exited (0) 2 minutes ago"}',
                ].join("\n"),
            ),
            "eudiplo",
        );

        expect(check).toEqual({
            name: "service containers",
            status: "pass",
            message: "2 container(s) running, 1 completed.",
        });
    });

    it("warns when nothing but completed containers is left", () => {
        const check = summarizeContainerStates(
            [
                {
                    name: "eudiplo-rustfs-init-1",
                    state: "exited",
                    status: "Exited (0) 1 hour ago",
                    exitCode: 0,
                },
            ],
            "eudiplo",
        );
        expect(check.status).toBe("warn");
    });

    it("warns when the project has no containers", () => {
        expect(summarizeContainerStates([], "eudiplo")).toMatchObject({
            status: "warn",
            message: expect.stringContaining("eudiplo"),
        });
    });

    it("fails on an unhealthy container", () => {
        const check = summarizeContainerStates(
            [
                {
                    name: "eudiplo-eudiplo-1",
                    state: "running",
                    status: "Up 10 minutes (unhealthy)",
                },
            ],
            "eudiplo",
        );
        expect(check.status).toBe("fail");
        expect(check.message).toContain("eudiplo-eudiplo-1");
    });

    it("warns when a container is not running", () => {
        const check = summarizeContainerStates(
            [
                { name: "a", state: "running", status: "Up 1 minute" },
                {
                    name: "b",
                    state: "exited",
                    status: "Exited (1) 3 minutes ago",
                },
            ],
            "eudiplo",
        );
        expect(check.status).toBe("warn");
        expect(check.message).toContain("1/2 running");
    });

    it("passes when everything runs, noting containers still starting", () => {
        const check = summarizeContainerStates(
            [
                {
                    name: "a",
                    state: "running",
                    status: "Up 1 minute (healthy)",
                },
                {
                    name: "b",
                    state: "running",
                    status: "Up 5 seconds (starting)",
                },
            ],
            "eudiplo",
        );
        expect(check.status).toBe("pass");
        expect(check.message).toContain("still starting");
    });
});

describe("doctor statuses", () => {
    const instance: InstanceConfig = {
        target: "external",
        url: "https://eudiplo.example.com",
    };

    function createContext(overrides: Partial<CommandContext> = {}) {
        return {
            cwd: "/",
            env: {},
            stdout: { write: () => true },
            stderr: { write: () => true },
            fetch: async () => new Response("{}", { status: 200 }),
            ...overrides,
        } as CommandContext;
    }

    it("skips the checks that need a URL instead of repeating the failure", async () => {
        const checks = await runDoctor(
            { ...instance, url: "not-a-url" },
            createContext(),
            [],
            { now },
        );

        expect(status(checks, "public URL")).toBe("fail");
        expect(status(checks, "API reachability")).toBe("skip");
        expect(status(checks, "health endpoint")).toBe("skip");
        expect(status(checks, "TLS certificate")).toBe("skip");
    });

    it("skips client connectivity when no client URL is configured", async () => {
        const checks = await runDoctor(instance, createContext(), [], {
            now,
            readCertificate: async () => certificate("2027-01-01"),
        });

        expect(status(checks, "client connectivity")).toBe("skip");
    });

    it("counts each status and renders SKIP", () => {
        const checks: DoctorCheck[] = [
            { name: "a", status: "pass", message: "" },
            { name: "b", status: "warn", message: "" },
            { name: "c", status: "skip", message: "not applicable" },
        ];

        expect(summarizeChecks(checks)).toEqual({
            pass: 1,
            warn: 1,
            fail: 0,
            skip: 1,
        });
        expect(formatSummary(summarizeChecks(checks))).toBe(
            "1 passed, 1 warning(s), 0 failure(s), 1 skipped",
        );
        expect(formatChecks(checks)).toContain("SKIP c: not applicable");
    });

    it("fails on warnings only in strict mode, and never on skips", () => {
        const warned: DoctorCheck[] = [
            { name: "a", status: "warn", message: "" },
        ];
        const skipped: DoctorCheck[] = [
            { name: "a", status: "skip", message: "" },
        ];

        expect(hasFailedChecks(warned)).toBe(false);
        expect(hasFailedChecks(warned, true)).toBe(true);
        expect(hasFailedChecks(skipped)).toBe(false);
        expect(hasFailedChecks(skipped, true)).toBe(false);
    });
});

function status(checks: DoctorCheck[], name: string): string | undefined {
    return checks.find((check) => check.name === name)?.status;
}
