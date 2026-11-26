/** Injection token of the {@link ConfigTemplatePolicy}. */
export const CONFIG_TEMPLATE_POLICY = Symbol("CONFIG_TEMPLATE_POLICY");

/**
 * What the `${VAR}` placeholders of files in tenant folders may name, from
 * the operator's secret policy file (`templates`).
 */
export interface ConfigTemplatePolicy {
    /**
     * Variables the files of every tenant folder may use: names
     * (`PUBLIC_URL`) and prefixes ending in `*` (`SHOP_*`). Undefined when
     * the policy file sets none: then every variable that is no setting of
     * EUDIPLO and no cloud credential of the instance may be used, as
     * before.
     */
    tenant?: readonly string[];
}

/** A variable name, or a prefix of names ending in `*`. */
export const TEMPLATE_PATTERN = /^[A-Z0-9_]+\*?$|^\*$/;
