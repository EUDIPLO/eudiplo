import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { HttpKmsAdapter } from "./http-kms.adapter.js";

describe("HttpKmsAdapter mTLS files", () => {
    const dir = mkdtempSync(join(tmpdir(), "http-kms-"));
    const pem = join(dir, "client.pem");
    writeFileSync(pem, "-----BEGIN CERTIFICATE-----\n");
    const large = join(dir, "large.pem");
    writeFileSync(large, Buffer.alloc(1024 * 1024 + 1));

    afterAll(() => rmSync(dir, { recursive: true }));

    const create = (auth: Record<string, string>) =>
        new HttpKmsAdapter(
            {
                providerId: "signer",
                baseUrl: "https://signer.example.com",
                auth: { type: "mtls", ...auth } as any,
            },
            {} as any,
        );

    it("reads regular certificate, key and CA files", () => {
        const adapter = create({ certFile: pem, keyFile: pem, caFile: pem });

        const options = (adapter as any).httpsAgent.options;
        for (const content of [options.cert, options.key, options.ca]) {
            expect(content).toEqual(readFileSync(pem));
        }
    });

    it("dispose closes the connections of the mTLS agent, and is harmless without one", () => {
        const adapter = create({ certFile: pem, keyFile: pem });
        const destroy = vi.spyOn((adapter as any).httpsAgent, "destroy");

        adapter.dispose();

        expect(destroy).toHaveBeenCalledTimes(1);
        expect(() =>
            new HttpKmsAdapter(
                { providerId: "plain", baseUrl: "https://signer.example.com" },
                {} as any,
            ).dispose(),
        ).not.toThrow();
    });

    it.skipIf(process.platform === "win32")(
        "refuses a pipe nobody writes to without waiting for it",
        () => {
            const fifo = join(dir, "pipe.pem");
            execFileSync("mkfifo", [fifo]);

            expect(() => create({ certFile: pem, keyFile: fifo })).toThrow(
                /must be a regular file/,
            );
        },
    );

    // Reading a device never returns, so it must be refused before the read.
    it.each([
        ["a device", { certFile: pem, keyFile: "/dev/zero" }],
        ["a directory", { certFile: dir, keyFile: pem }],
        ["a file over 1 MiB", { certFile: pem, keyFile: pem, caFile: large }],
    ])("refuses %s", (_name, auth) => {
        expect(() => create(auth)).toThrow(/must be a regular file/);
    });
});

describe("HttpKmsAdapter request paths", () => {
    const create = (paths: { keysPath?: string; healthPath?: string }) =>
        new HttpKmsAdapter(
            {
                providerId: "signer",
                baseUrl: "https://signer.example.com",
                ...paths,
            },
            {} as any,
        );

    it("accepts a baseUrl with credentials", () => {
        expect(
            () =>
                new HttpKmsAdapter(
                    {
                        providerId: "signer",
                        baseUrl: "https://user:pass@signer.example.com",
                    },
                    {} as any,
                ),
        ).not.toThrow();
    });

    it("accepts paths on the server of baseUrl", () => {
        expect(() =>
            create({ keysPath: "/v1/keys", healthPath: "/healthz?full=1" }),
        ).not.toThrow();
    });

    // The credentials of the provider would be sent to another server.
    it.each([
        { keysPath: "@attacker.example/keys" },
        { keysPath: ".attacker.example/keys" },
        { healthPath: ":8443/health" },
        { healthPath: "@attacker.example/health" },
    ])("refuses %j", (paths) => {
        expect(() => create(paths)).toThrow(
            /must be a path on the server of baseUrl/,
        );
    });
});
