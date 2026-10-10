import { Command } from "commander";
import type { CommandContext } from "../../types.js";
import { loadCliState, parsedArgs, type SetExitCode } from "../shared.js";
import {
    runInstanceAdd,
    runInstanceList,
    runInstanceRemove,
    runInstanceRename,
    runInstanceShow,
    runInstanceUpdate,
    runInstanceUse,
} from "./action.js";

export function createInstanceCommand(
    context: CommandContext,
    setExitCode: SetExitCode,
): Command {
    const instance = new Command("instance")
        .description("Manage configured EUDIPLO instances")
        .helpCommand(true);
    instance
        .command("list")
        .alias("ls")
        .description("List configured EUDIPLO instances")
        .action(async () => {
            const { config } = await loadCliState(context);
            setExitCode(runInstanceList(config, context));
        });
    instance
        .command("show [name]")
        .description("Show configured instance details")
        .action(async (name) => {
            const { config } = await loadCliState(context);
            setExitCode(
                runInstanceShow(
                    config,
                    parsedArgs("instance", "show", name ? [name] : [], {}),
                    context,
                ),
            );
        });
    instance
        .command("use <name>")
        .description("Set the default EUDIPLO instance")
        .action(async (name) => {
            const { configPath, config } = await loadCliState(context);
            setExitCode(
                await runInstanceUse(
                    configPath,
                    config,
                    parsedArgs("instance", "use", [name], {}),
                    context,
                ),
            );
        });
    instance
        .command("update <name>")
        .description("Change the API or client URL of an instance")
        .option("--url <url>", "new EUDIPLO API URL")
        .option("--client-url <url>", "new web client URL")
        .option("--no-client-url", "remove the web client URL")
        .action(async (name, options) => {
            const { configPath, config } = await loadCliState(context);
            setExitCode(
                await runInstanceUpdate(
                    configPath,
                    config,
                    parsedArgs("instance", "update", [name], options),
                    context,
                ),
            );
        });
    instance
        .command("rename <old-name> <new-name>")
        .description("Rename an instance; the default follows it")
        .action(async (oldName, newName) => {
            const { configPath, config } = await loadCliState(context);
            setExitCode(
                await runInstanceRename(
                    configPath,
                    config,
                    parsedArgs("instance", "rename", [oldName, newName], {}),
                    context,
                ),
            );
        });
    instance
        .command("remove <name>")
        .alias("rm")
        .description("Unregister an EUDIPLO instance")
        .option(
            "--default <name>",
            "instance to make the default when removing the current default",
        )
        .action(async (name, options) => {
            const { configPath, config } = await loadCliState(context);
            setExitCode(
                await runInstanceRemove(
                    configPath,
                    config,
                    parsedArgs("instance", "remove", [name], options),
                    context,
                ),
            );
        });
    instance
        .command("add <name>")
        .description("Register an existing EUDIPLO deployment")
        .requiredOption("--url <url>", "EUDIPLO API URL")
        .option(
            "--target <compose|external|kubernetes>",
            "deployment target",
            "external",
        )
        .option("--client-url <url>", "optional web client URL")
        .option("--context <name>", "Kubernetes context")
        .option("--namespace <name>", "Kubernetes namespace")
        .option(
            "--workload <service=kind/name,...>",
            "Kubernetes workloads, for example backend=deployment/eudiplo",
        )
        .option("--read-only", "refuse commands that change the deployment")
        .action(async (name, options) => {
            const { configPath, config } = await loadCliState(context);
            setExitCode(
                await runInstanceAdd(
                    configPath,
                    config,
                    parsedArgs("instance", "add", [name], options),
                    context,
                ),
            );
        });
    instance.action(function showInstanceHelp() {
        this.outputHelp();
    });
    return instance;
}
