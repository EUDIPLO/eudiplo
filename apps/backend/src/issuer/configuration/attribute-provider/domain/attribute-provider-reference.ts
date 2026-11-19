/** A credential config of the provider's tenant that names the provider. */
export interface AttributeProviderReference {
    /** Kind of configuration; credential configs are the only kind. */
    kind: "CredentialConfig";
    /** ID of the credential config. */
    id: string;
    description?: string;
}

/** Thrown when an attribute provider that credential configs name is deleted. */
export class AttributeProviderInUseError extends Error {
    constructor(
        readonly providerId: string,
        readonly references: AttributeProviderReference[],
    ) {
        super(attributeProviderInUseMessage(providerId, references));
        this.name = "AttributeProviderInUseError";
    }
}

/**
 * `Attribute provider "crm" is still used by 2 credential configs ("pid",
 * "mdl"). …`
 */
function attributeProviderInUseMessage(
    providerId: string,
    references: AttributeProviderReference[],
): string {
    const count = references.length;
    const ids = references.map(({ id }) => JSON.stringify(id)).join(", ");
    return `Attribute provider ${JSON.stringify(providerId)} is still used by ${count} credential ${count === 1 ? "config" : "configs"} (${ids}). Remove these references before deleting the attribute provider.`;
}
