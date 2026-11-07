// Entity info of a managed trust list (`entities[].info` of a TrustList) is
// published in the LoTE document of ETSI TS 119 602 V1.1.1, so its country
// code and language tag follow clauses 6.1.5 and 6.1.4 (TrustList v2).

/**
 * ISO 3166-1 alpha-2 codes (officially assigned), which ETSI TS 119 602
 * clause 6.1.5 a) requires for postal address countries, with its exceptions:
 * "UK" instead of "GB", "EL" instead of "GR", and "EU" for the European Union.
 */
export const TRUST_LIST_COUNTRY_CODES: readonly string[] = [
    ..."AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GD GE GF GG GH GI GL GM GN GP GQ GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
        " ",
    ),
    "UK",
    "EL",
    "EU",
].sort((a, b) => a.localeCompare(b));

/** ISO 3166-1 codes that ETSI TS 119 602 clause 6.1.5 replaces. */
const COUNTRY_CODE_EXCEPTIONS: Readonly<Record<string, string>> = {
    GB: "UK",
    GR: "EL",
};

/**
 * The shape of a country code, for the OpenAPI description: the request
 * schema lists the accepted codes, a pattern keeps the SDK type a string.
 */
export const TRUST_LIST_COUNTRY_PATTERN = "^[A-Z]{2}$";

/** Explains the accepted country codes; shared by the API, the CLI and the migration. */
export const TRUST_LIST_COUNTRY_MESSAGE =
    'Use an ISO 3166-1 alpha-2 code in capital letters, for example DE, with "UK" for the United Kingdom, "EL" for Greece and "EU" for the European Union (ETSI TS 119 602 clause 6.1.5).';

export const TRUST_LIST_COUNTRY_DESCRIPTION =
    'Optional country of the postal address: an ISO 3166-1 alpha-2 code in capital letters, with "UK" for the United Kingdom, "EL" for Greece and "EU" for the European Union (ETSI TS 119 602 clause 6.1.5). Defaults to EU.';

/**
 * A well-formed IETF RFC 5646 language tag in lower case, as ETSI TS 119 602
 * clause 6.1.4 requires: language (with extended language subtags), script,
 * region, variants, extensions and private use. A tag without a language
 * subtag (private use alone) and grandfathered tags are not accepted. The pattern has no lookarounds or
 * backreferences, so JSON Schema validators and RE2 run it as well.
 */
export const TRUST_LIST_LANGUAGE_TAG_PATTERN = String.raw`^(?:(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?)$`;

const LANGUAGE_TAG = new RegExp(TRUST_LIST_LANGUAGE_TAG_PATTERN);

/** Explains the accepted language tags; shared by the API, the CLI and the migration. */
export const TRUST_LIST_LANGUAGE_MESSAGE =
    "Use an IETF RFC 5646 language tag in lower case, for example en or de-at (ETSI TS 119 602 clause 6.1.4).";

export const TRUST_LIST_LANGUAGE_DESCRIPTION =
    "Optional language of every text the entity publishes (name, service names, postal address, contact, information URI): an IETF RFC 5646 language tag in lower case, for example en or de-at (ETSI TS 119 602 clause 6.1.4). Defaults to en.";

export const TRUST_LIST_URI_DESCRIPTION =
    "Optional absolute URI where relying parties find information about the entity, published as TEInformationURI. Write it as a URL parser serializes it, for example https://example.com/about with spaces percent-encoded.";

/** Explains the accepted URIs; shared by the API, the CLI and the migration. */
export const TRUST_LIST_URI_MESSAGE =
    "Use an absolute URI written as a URL parser serializes it (RFC 3986 syntax), for example https://example.com/about.";

/** Whether `value` is a country code a trust list may publish. */
export function isTrustListCountryCode(value: string): boolean {
    return TRUST_LIST_COUNTRY_CODES.includes(value);
}

/** Whether `value` is a language tag a trust list may publish. */
export function isTrustListLanguageTag(value: string): boolean {
    return LANGUAGE_TAG.test(value);
}

/**
 * The country code a trust list publishes for `value`, or `undefined` when it
 * cannot be one: surrounding spaces are trimmed, letters capitalized, and
 * "GB" and "GR" become "UK" and "EL". Names such as "Germany" are not
 * converted.
 */
export function trustListCountryCode(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const upper = value.trim().toUpperCase();
    const code = COUNTRY_CODE_EXCEPTIONS[upper] ?? upper;
    return isTrustListCountryCode(code) ? code : undefined;
}

/**
 * The language tag a trust list publishes for `value`, or `undefined` when it
 * is no well-formed RFC 5646 tag: surrounding spaces are trimmed and letters
 * lowercased, and "_" is not turned into "-".
 */
export function trustListLanguageTag(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const tag = value.trim().toLowerCase();
    return isTrustListLanguageTag(tag) ? tag : undefined;
}

/**
 * Whether `value` is an absolute URI a trust list may publish as
 * TEInformationURI (ETSI TS 119 602 clauses 6.1.2 and 6.5.4: RFC 3986
 * syntax). The WHATWG URL parser repairs input such as spaces or
 * backslashes, so the value must already be in its serialized form; only a
 * missing "/" path after the host is tolerated.
 */
export function isTrustListEntityUri(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return url.href === value || url.href === `${value}/`;
}

// TEElectronicAddress (ETSI TS 119 602 clause 6.5.3.2, format per 6.3.5.2):
// an e-mail address as a mailto: URI and a web-site URI are mandatory, a
// telephone number is optional.

/**
 * One e-mail address, bare or as a `mailto:` URI (RFC 6068), limited to
 * characters that need no percent-encoding in the URI (RFC 6068 section 2
 * requires "/", "&" and "=" to be encoded, so they are refused): a dot-atom local part
 * and a domain of ASCII letters, digits and hyphens with at least one dot.
 * Address lists and header fields (`?subject=`) are not accepted. The pattern
 * has no lookarounds or backreferences, so JSON Schema validators and RE2
 * run it as well.
 */
export const TRUST_LIST_EMAIL_PATTERN = String.raw`^(?:mailto:)?[A-Za-z0-9!$'*+_~-]+(?:\.[A-Za-z0-9!$'*+_~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$`;

const EMAIL = new RegExp(TRUST_LIST_EMAIL_PATTERN);

export const TRUST_LIST_EMAIL_DESCRIPTION =
    "E-mail address of the entity, for example info@example.com or mailto:info@example.com, published as a mailto: URI in TEElectronicAddress (ETSI TS 119 602 clause 6.5.3.2). Use ASCII characters; write an internationalized domain in its xn-- form.";

/** Explains the accepted e-mail addresses; shared by the API, the CLI and the migration. */
export const TRUST_LIST_EMAIL_MESSAGE =
    "Use one e-mail address, for example info@example.com or mailto:info@example.com, in ASCII characters (ETSI TS 119 602 clause 6.5.3.2).";

export const TRUST_LIST_WEBSITE_DESCRIPTION =
    "Web site of the entity, an absolute http or https URI published in TEElectronicAddress (ETSI TS 119 602 clause 6.5.3.2). Write it as a URL parser serializes it, for example https://example.com/.";

/**
 * The shape of a web-site URI for JSON Schema validators, which do not run
 * {@link isTrustListWebsite}: an http or https URI without spaces.
 */
export const TRUST_LIST_WEBSITE_PATTERN = String.raw`^https?://[^\s/?#]+(?:[/?#]\S*)?$`;

/** Explains the accepted web-site URIs; shared by the API, the CLI and the migration. */
export const TRUST_LIST_WEBSITE_MESSAGE =
    "Use an absolute http or https URI written as a URL parser serializes it, for example https://example.com/ (ETSI TS 119 602 clause 6.5.3.2).";

/**
 * A global telephone number, bare or as a `tel:` URI (RFC 3966): "+", then 3
 * to 15 digits (E.164), each optionally followed by one visual separator
 * "-", "." , "(" or ")". Spaces are not part of a tel: URI.
 */
export const TRUST_LIST_PHONE_PATTERN = String.raw`^(?:tel:)?\+(?:[0-9][().-]?){2,14}[0-9]$`;

const PHONE = new RegExp(TRUST_LIST_PHONE_PATTERN);

export const TRUST_LIST_PHONE_DESCRIPTION =
    "Optional telephone number of the entity in international form, for example +49-30-1234567 or tel:+49-30-1234567, published as a tel: URI in TEElectronicAddress (ETSI TS 119 602 clause 6.5.3.2).";

/** Explains the accepted telephone numbers, for the API and the JSON Schema. */
export const TRUST_LIST_PHONE_MESSAGE =
    'Use a telephone number in international form without spaces, for example +49-30-1234567 or tel:+49-30-1234567 (RFC 3966: "+", 3 to 15 digits, "-", ".", "(" and ")" as separators).';

/** Whether `value` is an e-mail address a trust list may publish. */
export function isTrustListEmail(value: string): boolean {
    return EMAIL.test(value);
}

/** The `mailto:` URI a trust list publishes for an accepted e-mail address. */
export function trustListMailtoUri(value: string): string {
    return value.startsWith("mailto:") ? value : `mailto:${value}`;
}

/** Whether `value` is a web-site URI a trust list may publish. */
export function isTrustListWebsite(value: string): boolean {
    // The serialized form also refuses "HTTPS://..." and "https:example.com".
    return /^https?:/.test(value) && isTrustListEntityUri(value);
}

/** Whether `value` is a telephone number a trust list may publish. */
export function isTrustListPhone(value: string): boolean {
    return PHONE.test(value);
}

/** The `tel:` URI a trust list publishes for an accepted telephone number. */
export function trustListTelUri(value: string): string {
    return value.startsWith("tel:") ? value : `tel:${value}`;
}
