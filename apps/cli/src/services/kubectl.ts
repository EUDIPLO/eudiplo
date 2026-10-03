import type { InstanceConfig } from "../types.js";

export interface KubernetesScope {
    context: string;
    namespace: string;
}

/**
 * Every kubectl invocation carries an explicit context and namespace so a
 * command can never fall through to whatever the user's current kubeconfig
 * happens to point at.
 */
function scopeArgs(scope: KubernetesScope): string[] {
    return ["--context", scope.context, "--namespace", scope.namespace];
}

export function resolveScope(
    instance: InstanceConfig,
    instanceName: string,
): KubernetesScope {
    if (!instance.context) {
        throw new Error(
            `Instance ${instanceName} does not define a Kubernetes context.`,
        );
    }
    if (!instance.namespace) {
        throw new Error(
            `Instance ${instanceName} does not define a Kubernetes namespace.`,
        );
    }
    return { context: instance.context, namespace: instance.namespace };
}

/**
 * Workload names from deployment/k8s/base, used when an instance is registered
 * without an explicit --workload map.
 */
export const defaultWorkloads: Record<string, string> = {
    backend: "deployment/eudiplo",
    client: "deployment/eudiplo-client",
};

/**
 * Resolves a `--service` value against the configured workload map. Refuses
 * to guess: with several workloads configured and no service named, the
 * caller has to be explicit.
 */
export function resolveWorkload(
    instance: InstanceConfig,
    service: string | undefined,
): string {
    const workloads = instance.workloads ?? {};
    const names = Object.keys(workloads).sort();

    if (names.length === 0) {
        throw new Error(
            "No workloads are configured for this instance. Add them with: eudiplo instance add --workload <service>=<kind>/<name>",
        );
    }

    if (service === undefined) {
        if (names.length === 1) {
            return workloads[names[0]];
        }
        throw new Error(
            `Several workloads are configured (${names.join(", ")}). Name one with --service.`,
        );
    }

    const workload = workloads[service];
    if (!workload) {
        throw new Error(
            `Unknown service ${service}. Configured services: ${names.join(", ")}.`,
        );
    }
    return workload;
}

export function resolveWorkloads(
    instance: InstanceConfig,
    service: string | undefined,
): string[] {
    if (service !== undefined) {
        return [resolveWorkload(instance, service)];
    }
    const workloads = instance.workloads ?? {};
    return Object.keys(workloads)
        .sort()
        .map((name) => workloads[name]);
}

export function buildGetPodsArgs(scope: KubernetesScope): string[] {
    return ["get", "pods", ...scopeArgs(scope), "--output", "wide"];
}

export function buildGetWorkloadArgs(
    scope: KubernetesScope,
    workload: string,
): string[] {
    return ["get", workload, ...scopeArgs(scope), "--output", "json"];
}

export function buildLogsArgs(
    scope: KubernetesScope,
    workload: string,
    options: { follow?: boolean; tail?: number } = {},
): string[] {
    const args = ["logs", workload, ...scopeArgs(scope)];
    if (options.follow === true) {
        args.push("--follow");
    }
    if (options.tail !== undefined) {
        args.push("--tail", String(options.tail));
    }
    return args;
}

export function buildRestartArgs(
    scope: KubernetesScope,
    workload: string,
): string[] {
    return ["rollout", "restart", workload, ...scopeArgs(scope)];
}

export function buildRolloutStatusArgs(
    scope: KubernetesScope,
    workload: string,
): string[] {
    return ["rollout", "status", workload, ...scopeArgs(scope)];
}

export function buildCanIArgs(
    scope: KubernetesScope,
    verb: string,
    resource: string,
): string[] {
    return ["auth", "can-i", verb, resource, ...scopeArgs(scope)];
}

/**
 * EndpointSlice rather than Endpoints: the v1 Endpoints API is deprecated from
 * Kubernetes 1.33 and reading it makes the API server emit a deprecation
 * warning on every call.
 */
export function buildGetEndpointSlicesArgs(scope: KubernetesScope): string[] {
    return ["get", "endpointslices", ...scopeArgs(scope), "--output", "json"];
}

const dns1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const workloadReference = /^[a-z][a-z0-9.-]*\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Namespaces are DNS-1123 labels, which cannot start with a hyphen. Checking
 * the shape here means a configured value can never be read by kubectl as a
 * flag rather than as an argument.
 */
export function assertNamespace(value: string, label: string): void {
    if (!dns1123Label.test(value) || value.length > 63) {
        throw new Error(
            `${label} must be a lowercase DNS-1123 label (letters, digits and hyphens, not starting or ending with a hyphen).`,
        );
    }
}

/**
 * Context names are freer-form than namespaces, so this only rules out the
 * shapes that would be ambiguous on a command line.
 */
export function assertContextName(value: string, label: string): void {
    if (value.length === 0 || value.startsWith("-") || /\s/.test(value)) {
        throw new Error(
            `${label} must not be empty, start with a hyphen or contain whitespace.`,
        );
    }
}

export function assertWorkloadReference(value: string, label: string): void {
    if (!workloadReference.test(value)) {
        throw new Error(
            `${label} must be a workload reference of the form <kind>/<name>, for example deployment/eudiplo.`,
        );
    }
}

/**
 * Parses `backend=deployment/eudiplo,client=deployment/eudiplo-client` into a
 * workload map, validating each reference as it goes.
 */
export function parseWorkloadMap(value: string): Record<string, string> {
    const workloads: Record<string, string> = {};
    for (const entry of value.split(",")) {
        const trimmed = entry.trim();
        if (trimmed.length === 0) {
            continue;
        }
        const separator = trimmed.indexOf("=");
        if (separator <= 0) {
            throw new Error(
                `Workload ${trimmed} must be given as <service>=<kind>/<name>.`,
            );
        }
        const service = trimmed.slice(0, separator).trim();
        const reference = trimmed.slice(separator + 1).trim();
        if (Object.hasOwn(workloads, service)) {
            throw new Error(`Workload ${service} was given more than once.`);
        }
        assertWorkloadReference(reference, `Workload ${service}`);
        workloads[service] = reference;
    }

    if (Object.keys(workloads).length === 0) {
        throw new Error("At least one workload must be given.");
    }
    return workloads;
}
