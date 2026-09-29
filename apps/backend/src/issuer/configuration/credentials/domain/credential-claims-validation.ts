import type { ErrorObject } from "ajv";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { buildJsonSchema } from "../utils/derive.js";
import type { ClaimFieldDefinition } from "../utils/types.js";

/**
 * Resolved claims do not match the credential configuration. The message only
 * names claim paths and rules, never claim values, so it can be logged and
 * returned to clients.
 */
export class InvalidCredentialClaims extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidCredentialClaims";
    }
}

/**
 * Validates claims against the JSON schema derived from the configuration's
 * fields. Configurations without fields are not validated. Missing, mistyped,
 * unknown and invalid nested claims are rejected; schema defaults are applied
 * to `claims` in place.
 * @throws InvalidCredentialClaims
 */
export function assertClaimsMatchConfiguration(
    configuration: { id: string; fields?: unknown },
    claims: Record<string, unknown>,
): void {
    const schema = buildJsonSchema(
        (configuration.fields ?? []) as ClaimFieldDefinition[],
    );
    if (Object.keys(schema.properties ?? {}).length === 0) return;

    const ajv = new Ajv({
        allErrors: true,
        strict: true,
        useDefaults: true,
        validateSchema: false,
    });
    const validate = ajv.compile(schema as object);
    if (!validate(claims)) {
        throw new InvalidCredentialClaims(
            `Claims do not conform to the schema for credential configuration with id ${configuration.id}: ${formatClaimErrors(validate.errors)}`,
        );
    }
}

function joinClaimPath(instancePath: string, property: unknown): string {
    return `${instancePath}/${String(property)}`;
}

/** Claim paths and rule descriptions only, never claim values. */
function formatClaimErrors(errors: ErrorObject[] | null | undefined): string {
    return (errors ?? [])
        .map((error) => {
            if (error.keyword === "required") {
                return `${joinClaimPath(error.instancePath, error.params.missingProperty)}: missing required claim`;
            }
            if (error.keyword === "additionalProperties") {
                return `${joinClaimPath(error.instancePath, error.params.additionalProperty)}: unexpected claim`;
            }
            return `${error.instancePath || "/"}: ${error.message}`;
        })
        .join("; ");
}
