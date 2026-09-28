import type { BitsPerStatus } from "@owf/token-status-list";

export const STATUS_LIST_SETTINGS = Symbol("STATUS_LIST_SETTINGS");

export interface StatusListSettings {
    publicUrl: string;
    statusCapacity: number;
    statusBits: BitsPerStatus;
}
