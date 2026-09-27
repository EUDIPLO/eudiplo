import type { CertificateReader } from "./services/tls-expiry.js";
export type DeploymentTarget = "compose" | "external" | "kubernetes";
type CliInstallationMethod = "npm" | "standalone";

export interface InstanceConfig {
    target: DeploymentTarget;
    url: string;
    clientUrl?: string;
    composeFile?: string;
    composeFiles?: string[];
    composeProfiles?: string[];
    envFile?: string;
    projectName?: string;
    projectDirectory?: string;
    context?: string;
    namespace?: string;
    workloads?: Record<string, string>;
    readOnly?: boolean;
}

export interface CliConfig {
    defaultInstance?: string;
    instances: Record<string, InstanceConfig>;
}

export interface CommandContext {
    cwd: string;
    env: NodeJS.ProcessEnv;
    installationMethod?: CliInstallationMethod;
    interactive?: boolean;
    prompt?: (question: string) => Promise<string>;
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
    fetch: typeof fetch;
    /** Reads a peer certificate; injectable so tests never open sockets. */
    readCertificate?: CertificateReader;
}

export interface DriverCommandOptions {
    instanceName: string;
    instance: InstanceConfig;
    args: string[];
    flags: Record<string, string | boolean>;
    context: CommandContext;
}

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
    name: string;
    status: CheckStatus;
    message: string;
}

export interface DeploymentDriver {
    target: DeploymentTarget;
    diagnostics(
        instance: InstanceConfig,
        context: CommandContext,
    ): Promise<DoctorCheck[]>;
    up?(options: DriverCommandOptions): Promise<number>;
    down?(options: DriverCommandOptions): Promise<number>;
    logs?(options: DriverCommandOptions): Promise<number>;
    ps?(options: DriverCommandOptions): Promise<number>;
    restart?(options: DriverCommandOptions): Promise<number>;
    pull?(options: DriverCommandOptions): Promise<number>;
}

export interface ParsedArgs {
    command?: string;
    subject?: string;
    positionals: string[];
    flags: Record<string, string | boolean>;
}
