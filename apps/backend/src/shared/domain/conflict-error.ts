/**
 * Base class for transport-neutral "resource already exists" errors raised by
 * application/domain code and repository adapters. The HTTP boundary
 * (`AllExceptionsFilter`) maps every subclass to 409.
 */
export abstract class ConflictError extends Error {}

/**
 * A create names an ID the tenant already uses for a resource of this kind.
 * Creates never replace a stored resource; it is changed with its update
 * request instead. The services check before they save, so two concurrent
 * creates of the same new ID can still both succeed, the later one winning.
 */
export class ResourceIdTaken extends ConflictError {
    /**
     * @param resource - The kind of resource, e.g. "Credential configuration".
     * @param id - The taken ID.
     */
    constructor(resource: string, id: string) {
        super(
            `${resource} '${id}' already exists. Choose another ID, or update the existing one.`,
        );
        this.name = "ResourceIdTaken";
    }
}
