import type { SessionStoreMode } from "./session-log-store.service.js";

export const SESSION_LOGGING_SETTINGS = Symbol("SESSION_LOGGING_SETTINGS");

export interface SessionLoggingSettings {
    enabled: boolean;
    storeMode: SessionStoreMode;
}
