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
    "Optional language of the entity's name, postal address, contact and information URI: an IETF RFC 5646 language tag in lower case, for example en or de-at (ETSI TS 119 602 clause 6.1.4). Defaults to en. With another language, the list publishes these texts in that language and again under en with the same text, since every list supports English (clause 6.1.4); service names are published in English only.";

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
