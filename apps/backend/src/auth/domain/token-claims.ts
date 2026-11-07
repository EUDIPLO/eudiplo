/**
 * Value of the claim `name` of a token payload: the claim with exactly this
 * name, so namespaced names such as `https://eudiplo.example.com/roles` work,
 * or else the value at the dot path `name` in nested claims, such as
 * `resource_access.eudiplo.roles`. Only own properties are read.
 */
export function claimValue(payload: object, name: string): unknown {
    if (Object.hasOwn(payload, name)) {
        return (payload as Record<string, unknown>)[name];
    }
    let value: unknown = payload;
    for (const key of name.split(".")) {
        if (
            typeof value !== "object" ||
            value === null ||
            !Object.hasOwn(value, key)
        ) {
            return undefined;
        }
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}

/**
 * Role names of a roles claim: the strings of an array, or the keys of an
 * object, as Zitadel's `urn:zitadel:iam:org:project:roles` holds them.
 * Anything else holds no roles.
 */
export function roleNames(claim: unknown): string[] {
    if (Array.isArray(claim)) {
        return claim.filter((role): role is string => typeof role === "string");
    }
    if (typeof claim === "object" && claim !== null) {
        return Object.keys(claim);
    }
    return [];
}
