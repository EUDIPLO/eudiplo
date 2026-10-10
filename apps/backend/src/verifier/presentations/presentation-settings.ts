export interface PresentationSettings {
    publicUrl: string;
    /** `SKIP_TRUST_AUTHORITY`: allow DCQL credential queries without trusted authorities. */
    skipTrustAuthority: boolean;
}
export const PRESENTATION_SETTINGS = Symbol("PRESENTATION_SETTINGS");
