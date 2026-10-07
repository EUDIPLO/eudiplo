import Joi from "joi";
import {
  branchType,
  extractConditionsFromKeyDesc,
  flattenMetas,
  formatDefault,
} from "./helpers";

// "conditional": required only under a condition listed in `conditions`.
type Presence = "required" | "optional" | "conditional";

interface ConfigItem {
  key: string;
  type: string;
  defaultValue?: unknown;
  /** The default as display text, with inline code in backticks. */
  defaultText?: string;
  allowedValues?: unknown[];
  description: string;
  presence: Presence;
  group: string;
  order: number;
  secret: boolean;
  conditions: string[];
  meta: Record<string, any>;
}

interface ConfigGroup {
  name: string;
  order: number;
  items: ConfigItem[];
}

export interface ConfigModel {
  createdAt: string;
  groups: ConfigGroup[];
  all: ConfigItem[];
}

export function buildModelFromSchema(schema: Joi.ObjectSchema): ConfigModel {
  const described = schema.describe() as any;
  const descKeys: Record<string, any> = described.keys ?? {};
  const allKeys = Object.keys(descKeys);

  const items: ConfigItem[] = [];

  for (const key of allKeys) {
    const keyDesc = descKeys[key] ?? {};
    const flags = keyDesc.flags ?? {};
    const meta = flattenMetas(keyDesc);

    const group = meta.group ?? "Other";
    const order = Number.isFinite(meta.order) ? Number(meta.order) : 999;
    const secret = meta.secret === true;

    const description =
      flags.description ||
      (Array.isArray(keyDesc.notes) ? keyDesc.notes.join(" ") : "") ||
      "";

    // A computed default (a function, or a value that depends on where the
    // docs are built) is described by the key's `defaultText` meta.
    const defaultText: string | undefined =
      typeof meta.defaultText === "string" ? meta.defaultText : undefined;
    const { conditions, required } = extractConditionsFromKeyDesc(
      keyDesc,
      defaultText,
    );

    const presence: Presence =
      flags.presence === "required"
        ? "required"
        : required
        ? "conditional"
        : "optional";

    const baseType = Array.isArray(keyDesc.type)
      ? keyDesc.type.join(" | ")
      : keyDesc.type ?? "unknown";
    const type = baseType === "any" ? branchType(keyDesc) ?? baseType : baseType;

    const hasDefault = Object.prototype.hasOwnProperty.call(flags, "default");
    const allowedValues =
      keyDesc.flags?.only === true && Array.isArray(keyDesc.allow)
        ? keyDesc.allow
        : undefined;

    items.push({
      key,
      type,
      defaultValue:
        hasDefault && typeof flags.default !== "function"
          ? flags.default
          : undefined,
      // A key without its own default uses `defaultText` only in the
      // condition that sets one (e.g. LOCAL_STORAGE_DIR).
      defaultText: hasDefault
        ? defaultText ?? formatDefault(flags.default)
        : undefined,
      allowedValues,
      description,
      presence,
      group,
      order,
      secret,
      conditions,
      meta,
    });
  }

  // Group & sort
  const groupsMap = new Map<string, ConfigItem[]>();
  for (const it of items) {
    const arr = groupsMap.get(it.group) ?? [];
    arr.push(it);
    groupsMap.set(it.group, arr);
  }

  const groups: ConfigGroup[] = Array.from(groupsMap.entries())
    .map(([name, arr]) => {
      arr.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
      const order = arr.reduce((m, r) => Math.min(m, r.order), 999);
      return { name, order, items: arr };
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  return {
    createdAt: new Date().toISOString(),
    groups,
    all: items,
  };
}
