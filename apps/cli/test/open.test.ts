import { describe, expect, it } from "vitest";
import {
    type OpenDependencies,
    resolveOpenTarget,
    runOpenCommand,
} from "../src/commands/open/action.js";
import {
    assertWebUrl,
    type BrowserLauncher,
    chooseLauncher,
} from "../src/services/browser.js";
import type {
    CliConfig,
    CommandContext,
    InstanceConfig,
} from "../src/types.js";

const url = "http://localhost:4200/?tenant=a&x=1";

function which(available: Record<string, string>) {
    return async (name: string) => available[name];
}

describe("browser launcher selection", () => {
    it("uses open on macOS", async () => {
        expect(
            await chooseLauncher(url, {
                platform: "darwin",
                env: {},
                which: which({}),
            }),
        ).toEqual({ command: "open", args: [url] });
    });

    it("avoids cmd.exe on Windows so '&' in a URL is never parsed", async () => {
        const launcher = await chooseLauncher(url, {
            platform: "win32",
            env: {},
            which: which({}),
        });
        expect(launcher?.command).toBe("rundll32.exe");
        expect(launcher?.args).toEqual(["url.dll,FileProtocolHandler", url]);
    });

    it("uses wslview inside WSL when it is installed", async () => {
        expect(
            await chooseLauncher(url, {
                platform: "linux",
                env: { WSL_DISTRO_NAME: "Ubuntu" },
                which: which({ wslview: "/usr/bin/wslview" }),
            }),
        ).toEqual({ command: "/usr/bin/wslview", args: [url] });
    });

    it("uses xdg-open only when a display is available", async () => {
        const tools = which({ "xdg-open": "/usr/bin/xdg-open" });
        expect(
            await chooseLauncher(url, {
                platform: "linux",
                env: { DISPLAY: ":0" },
                which: tools,
            }),
        ).toEqual({ command: "/usr/bin/xdg-open", args: [url] });
        expect(
            await chooseLauncher(url, {
                platform: "linux",
                env: {},
                which: tools,
            }),
        ).toBeUndefined();
    });

    it("prefers a bare $BROWSER command", async () => {
        expect(
            await chooseLauncher(url, {
                platform: "linux",
                env: { BROWSER: "firefox" },
                which: which({ firefox: "/usr/bin/firefox" }),
            }),
        ).toEqual({ command: "/usr/bin/firefox", args: [url] });
    });

    it.each(["firefox --new-window", "chrome %s", "sh -c 'x'"])(
        "ignores $BROWSER values that would need shell parsing: %s",
        async (browser) => {
            expect(
                await chooseLauncher(url, {
                    platform: "linux",
                    env: { BROWSER: browser },
                    which: which({ firefox: "/usr/bin/firefox" }),
                }),
            ).toBeUndefined();
        },
    );

    it.each(["file:///etc/passwd", "javascript:alert(1)", "ms-settings:"])(
        "refuses non-web URL %s",
        (value) => {
            expect(() => assertWebUrl(value)).toThrow(/only http and https/);
        },
    );
});

describe("eudiplo open", () => {
    const instance: InstanceConfig = {
        target: "compose",
        url: "http://localhost:3000",
        clientUrl: "http://localhost:4200",
    };

    it("targets the web client by default", () => {
        expect(resolveOpenTarget("local", instance, false)).toBe(
            "http://localhost:4200/",
        );
    });

    it("keeps a path prefix when targeting the API docs", () => {
        expect(
            resolveOpenTarget(
                "prod",
                { ...instance, url: "https://example.com/eudiplo" },
                true,
            ),
        ).toBe("https://example.com/eudiplo/api/docs");
    });

    it("explains how to proceed when no web client is configured", () => {
        expect(() =>
            resolveOpenTarget(
                "api-only",
                { ...instance, clientUrl: undefined },
                false,
            ),
        ).toThrow("Instance api-only has no web client URL. Use --docs");
    });

    it("prints the URL without launching when not interactive", async () => {
        const { context, output } = createContext({ interactive: false });
        const launched: BrowserLauncher[] = [];

        expect(
            await runOpenCommand(config(), parsed({}), context, deps(launched)),
        ).toBe(0);

        expect(output.stdout).toBe("http://localhost:4200/\n");
        expect(launched).toHaveLength(0);
    });

    it("prints the URL without launching with --print", async () => {
        const { context, output } = createContext({ interactive: true });
        const launched: BrowserLauncher[] = [];

        await runOpenCommand(
            config(),
            parsed({ print: true }),
            context,
            deps(launched, "darwin"),
        );

        expect(output.stdout).toBe("http://localhost:4200/\n");
        expect(launched).toHaveLength(0);
    });

    it("launches a browser in an interactive session", async () => {
        const { context, output } = createContext({ interactive: true });
        const launched: BrowserLauncher[] = [];

        await runOpenCommand(
            config(),
            parsed({}),
            context,
            deps(launched, "darwin"),
        );

        expect(launched).toEqual([
            { command: "open", args: ["http://localhost:4200/"] },
        ]);
        expect(output.stdout).toBe("Opening http://localhost:4200/\n");
    });

    it("falls back to printing when no browser is available", async () => {
        const { context, output } = createContext({ interactive: true });
        const launched: BrowserLauncher[] = [];

        // Linux without a display, wslview or $BROWSER.
        await runOpenCommand(
            config(),
            parsed({}),
            context,
            deps(launched, "linux"),
        );

        expect(launched).toHaveLength(0);
        expect(output.stdout).toBe(
            "No browser is available here. Open: http://localhost:4200/\n",
        );
    });

    it("falls back to printing when the launcher fails to start", async () => {
        const { context, output } = createContext({ interactive: true });

        await runOpenCommand(config(), parsed({}), context, {
            platform: "darwin",
            launch: async () => false,
        });

        expect(output.stdout).toContain("No browser is available here.");
    });

    it("leaves credentials out of the launched URL", async () => {
        const { context, output } = createContext({ interactive: true });
        const launched: BrowserLauncher[] = [];

        await runOpenCommand(
            withCredentials(),
            parsed({}),
            context,
            deps(launched, "darwin"),
        );

        expect(launched).toEqual([
            { command: "open", args: ["https://client.example.com/app"] },
        ]);
        expect(output.stdout).toBe("Opening https://client.example.com/app\n");
        expect(output.stderr).toContain(
            "Credentials in the instance URL were left out",
        );
        expect(output.stdout + output.stderr).not.toContain("s3cret");
    });

    it("prints the URL as configured with --print, with a warning", async () => {
        const { context, output } = createContext({ interactive: true });

        await runOpenCommand(
            withCredentials(),
            parsed({ docs: true, print: true }),
            context,
            deps([], "darwin"),
        );

        expect(output.stdout).toBe(
            "https://admin:s3cret@eudiplo.example.com/api/docs\n",
        );
        expect(output.stderr).toContain(
            "Warning: the printed URL contains credentials",
        );
    });

    function withCredentials(): CliConfig {
        return {
            defaultInstance: "local",
            instances: {
                local: {
                    ...instance,
                    url: "https://admin:s3cret@eudiplo.example.com",
                    clientUrl: "https://admin:s3cret@client.example.com/app",
                },
            },
        };
    }

    function config(): CliConfig {
        return { defaultInstance: "local", instances: { local: instance } };
    }
});

function parsed(flags: Record<string, string | boolean>) {
    return { command: "open", positionals: [], flags };
}

function deps(
    launched: BrowserLauncher[],
    platform: NodeJS.Platform = "linux",
): OpenDependencies {
    return {
        platform,
        launch: async (launcher) => {
            launched.push(launcher);
            return true;
        },
    };
}

function createContext({ interactive }: { interactive: boolean }) {
    const output = { stdout: "", stderr: "" };
    const context: CommandContext = {
        cwd: "/",
        installationMethod: "npm",
        env: { PATH: "" },
        interactive,
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
        fetch,
    };
    return { context, output };
}
