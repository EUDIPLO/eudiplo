import { z } from "zod";
import {
    type ConfigTemplatePolicy,
    TEMPLATE_PATTERN,
} from "../../config/config-template-policy.js";
import { SecretPolicy } from "../application/secret-policy.js";
import { SecretPolicyError } from "../domain/secret-errors.js";
import type { SecretSource } from "../ports/secret-source.js";
import { EnvSecretSource } from "./env-secret-source.js";
import { type VaultAuth, VaultSecretSource } from "./vault-secret-source.js";

/**
 * The Vault server of the instance. Its credentials are environment
 * variables, so the file holds no secret.
 */
const vaultSourceSchema = z
    .object({
        address: z.string().min(1),
        auth: z.discriminatedUnion("method", [
            z.object({ method: z.literal("token") }).strict(),
            z
                .object({
                    method: z.literal("approle"),
                    mount: z.string().min(1).optional(),
                })
                .strict(),
        ]),
        mounts: z
            .record(
                z.string().regex(/^[A-Za-z0-9._-]+$/),
                z
                    .object({ version: z.union([z.literal(1), z.literal(2)]) })
                    .strict(),
            )
            .refine((mounts) => Object.keys(mounts).length > 0, {
                message: "list at least one KV mount",
            }),
        namespace: z.string().min(1).optional(),
        allowHttp: z.boolean().optional(),
    })
    .strict();

const policyFileSchema = z
    .object({
        sources: z
            .object({ vault: vaultSourceSchema.optional() })
            .strict()
            .optional(),
        templates: z
            .object({
                tenant: z.array(
                    z
                        .string()
                        .regex(
                            TEMPLATE_PATTERN,
                            "a template grant is a variable name of A-Z, 0-9 and _, or a prefix of one ending in *",
                        ),
                ),
            })
            .strict()
            .optional(),
    })
    .passthrough();

/** Environment variables with the credentials of the Vault source. */
const SECRET_VAULT_TOKEN = "SECRET_VAULT_TOKEN";
const SECRET_VAULT_ROLE_ID = "SECRET_VAULT_ROLE_ID";
const SECRET_VAULT_SECRET_ID = "SECRET_VAULT_SECRET_ID";

export interface SecretPolicyFileInput {
    /** The file's text. */
    text: string;
    env: Readonly<Record<string, string | undefined>>;
    /** The `env` source, which reads `env` but refuses EUDIPLO's settings. */
    envSource: (env: SecretPolicyFileInput["env"]) => EnvSecretSource;
}

function vaultAuth(
    auth: z.infer<typeof vaultSourceSchema>["auth"],
    env: SecretPolicyFileInput["env"],
): VaultAuth {
    const required = (name: string) => {
        const value = env[name];
        if (!value)
            throw new SecretPolicyError([
                `sources.vault: set ${name} for the ${auth.method} login`,
            ]);
        return value;
    };
    return auth.method === "token"
        ? { method: "token", token: required(SECRET_VAULT_TOKEN) }
        : {
              method: "approle",
              roleId: required(SECRET_VAULT_ROLE_ID),
              secretId: required(SECRET_VAULT_SECRET_ID),
              ...(auth.mount ? { mount: auth.mount } : {}),
          };
}

/**
 * The operator's secret policy file: the sources (`env` always, `vault`
 * when `sources.vault` is set), the grants of the instance and the
 * tenants, and the variables `${VAR}` placeholders of tenant folders may
 * name (`templates`).
 *
 * @throws SecretPolicyError naming every problem. Messages never quote the
 * file's text.
 */
export function readSecretPolicyFile(input: SecretPolicyFileInput): {
    policy: SecretPolicy;
    sources: SecretSource[];
    templates: ConfigTemplatePolicy;
} {
    let json: unknown;
    try {
        json = JSON.parse(input.text);
    } catch {
        throw new SecretPolicyError(["the file is no valid JSON"]);
    }
    const parsed = policyFileSchema.safeParse(json);
    if (!parsed.success) {
        throw new SecretPolicyError(
            parsed.error.issues.map(
                (issue) =>
                    `${issue.path.join(".") || "(root)"}: ${issue.message}`,
            ),
        );
    }
    const { sources: sourceSettings, templates, ...grants } = parsed.data;
    const sources: SecretSource[] = [input.envSource(input.env)];
    const vault = sourceSettings?.vault;
    if (vault) {
        try {
            sources.push(
                new VaultSecretSource({
                    address: vault.address,
                    auth: vaultAuth(vault.auth, input.env),
                    mounts: vault.mounts,
                    ...(vault.namespace ? { namespace: vault.namespace } : {}),
                    ...(vault.allowHttp ? { allowHttp: true } : {}),
                }),
            );
        } catch (error) {
            if (error instanceof SecretPolicyError) throw error;
            throw new SecretPolicyError([
                `sources.vault.address: ${(error as Error).message}`,
            ]);
        }
    }
    return {
        policy: SecretPolicy.create(grants, sources),
        sources,
        templates: templates ? { tenant: templates.tenant } : {},
    };
}
