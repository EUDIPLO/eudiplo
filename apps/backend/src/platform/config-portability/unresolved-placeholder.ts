/** A `${VAR}` placeholder the plan reports as SECRET_REQUIRED. */
export const UNRESOLVED_PLACEHOLDER = /^\$\{[A-Z0-9_]+(?::[^}]*)?\}$/;

/** Whether `value`, or a string inside it, is an unresolved `${VAR}` placeholder. */
export function holdsUnresolvedPlaceholder(value: unknown): boolean {
    if (typeof value === "string") return UNRESOLVED_PLACEHOLDER.test(value);
    if (Array.isArray(value)) return value.some(holdsUnresolvedPlaceholder);
    if (value && typeof value === "object")
        return Object.values(value).some(holdsUnresolvedPlaceholder);
    return false;
}
