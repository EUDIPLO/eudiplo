export interface PresentationSettings {
    publicUrl: string;
    /** `SKIP_TRUST_AUTHORITY`: allow DCQL credential queries without trusted authorities. */
    skipTrustAuthority: boolean;
    /** `SKIP_OVERASKING_CHECK`: attach registration certificates that do not authorize every requested credential. */
    skipOveraskingCheck: boolean;
}
export const PRESENTATION_SETTINGS = Symbol("PRESENTATION_SETTINGS");
