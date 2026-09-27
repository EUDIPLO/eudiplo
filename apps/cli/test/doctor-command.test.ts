import { describe, expect, it } from "vitest";
import { runDoctorCommand } from "../src/commands/doctor/action.js";
import type { CliConfig, CommandContext } from "../src/types.js";

const validCertificate = async () => ({
    subject: "eudiplo.example.com",
    issuer: "Example CA",
    validTo: new Date("2027-01-01T00:00:00Z"),
});

function createContext(status: (path: string) => number) {
    const output = { stdout: "", stderr: "" };
    const context: CommandContext = {
        cwd: "/",
        env: {},
        readCertificate: validCertificate,
        stdout: {
            write(chunk: string | Uint8Array) {
                output.stdout += String(chunk);
                return true;
            },
        },
        stderr: {
            write(chunk: string | Uint8Array) {
                output.stderr += String(chunk);
                return true;
            },
        },
        fetch: async (input) => {
            const url = input instanceof URL ? input : new URL(String(input));
            return new Response("{}", { status: status(url.pathname) });
        },
    };
    return { context, output };
}

const healthy = () => 200;

const config: CliConfig = {
    defaultInstance: "production",
    instances: {
        production: {
            target: "external",
            url: "https://eudiplo.example.com",
        },
        staging: {
            target: "external",
            url: "http://staging.example.com",
        },
    },
};

function parsed(flags: Record<string, string | boolean>) {
    return { command: "doctor", positionals: [], flags };
}

describe("eudiplo doctor", () => {
    it("reports a summary line for the selected instance", async () => {
        const { context, output } = createContext(healthy);

        expect(await runDoctorCommand(config, parsed({}), context)).toBe(0);

        expect(output.stdout).toContain("Doctor for production (external)");
        expect(output.stdout).toContain("PASS API reachability");
        expect(output.stdout).toMatch(/\d+ passed, \d+ warning\(s\)/);
        expect(output.stdout).not.toContain("Doctor for staging");
    });

    it("runs every configured instance with --all", async () => {
        const { context, output } = createContext(healthy);

        expect(
            await runDoctorCommand(config, parsed({ all: true }), context),
        ).toBe(0);

        expect(output.stdout).toContain("Doctor for production (external)");
        expect(output.stdout).toContain("Doctor for staging (external)");
    });

    it("keeps exit code 0 for warnings, and fails them under --strict", async () => {
        // The staging instance is plain HTTP, which warns.
        const plain = createContext(healthy);
        expect(
            await runDoctorCommand(
                config,
                parsed({ instance: "staging" }),
                plain.context,
            ),
        ).toBe(0);
        expect(plain.output.stdout).toContain("WARN public URL");
        expect(plain.output.stdout).toContain("SKIP TLS certificate");

        const strict = createContext(healthy);
        expect(
            await runDoctorCommand(
                config,
                parsed({ instance: "staging", strict: true }),
                strict.context,
            ),
        ).toBe(1);
    });

    it("fails when a required endpoint is down", async () => {
        const { context, output } = createContext((path) =>
            path === "/health" ? 503 : 200,
        );

        expect(await runDoctorCommand(config, parsed({}), context)).toBe(1);
        expect(output.stdout).toContain("FAIL health endpoint");
    });

    it("aggregates failures across instances with --all", async () => {
        const { context } = createContext((path) =>
            path === "/health" ? 503 : 200,
        );

        expect(
            await runDoctorCommand(config, parsed({ all: true }), context),
        ).toBe(1);
    });
});
