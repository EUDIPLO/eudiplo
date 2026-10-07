import { Command } from "commander";
import type { CommandContext } from "../../types.js";
import { loadCliState, parsedArgs, type SetExitCode } from "../shared.js";
import { runDriverCommand } from "./action.js";

type DriverCommand = "up" | "down" | "logs" | "ps" | "restart" | "pull";

const descriptions: Record<DriverCommand, string> = {
    up: "Start the selected Compose deployment",
    down: "Stop the selected Compose deployment",
    logs: "Print the logs of the selected deployment, or stream them with --follow",
    ps: "List the running containers or pods for the selected deployment",
    restart: "Restart the workloads of the selected deployment",
    pull: "Download the configured images without changing configuration",
};

// Commands that act on a single workload rather than the whole deployment.
const serviceScoped: ReadonlySet<DriverCommand> = new Set([
    "logs",
    "restart",
    "pull",
]);

export function createDeploymentCommands(
    context: CommandContext,
    setExitCode: SetExitCode,
): Command[] {
    return (["up", "down", "logs", "ps", "restart", "pull"] as const).map(
        (name) => {
            const command = new Command(name)
                .description(descriptions[name])
                .argument(
                    "[args...]",
                    "additional arguments passed to the deployment runtime",
                )
                .option("--instance <name>", "select a configured instance");
            if (serviceScoped.has(name)) {
                command.option(
                    "--service <name>",
                    "select a single service (Compose) or configured workload (Kubernetes)",
                );
            }
            if (name === "logs") {
                command
                    .option("--follow", "stream new output as it arrives")
                    .option("--tail <lines>", "number of recent lines to show")
                    .option(
                        "--since <time>",
                        "show logs since a duration (10m, 2h) or timestamp (Compose instances)",
                    );
            }
            if (name === "restart") {
                command.option(
                    "--no-wait",
                    "return without waiting for the rollout to finish (Kubernetes instances)",
                );
            }
            return command.action(async (args, options) => {
                const { config } = await loadCliState(context);
                setExitCode(
                    await runDriverCommand(
                        config,
                        name,
                        parsedArgs(name, undefined, args, options),
                        context,
                    ),
                );
            });
        },
    );
}
