/**
 * URL of a VCT type metadata document that EUDIPLO hosts for a credential
 * configuration whose `vct` is an object instead of a URI.
 */
export function hostedVctUrl(
    publicUrl: string,
    tenantId: string,
    credentialConfigId: string,
): string {
    return `${publicUrl}/issuers/${tenantId}/credentials-metadata/vct/${credentialConfigId}`;
}
