import { BadRequestException } from "@nestjs/common";
import {
    isStatusListCapacity,
    STATUS_LIST_CAPACITY_MESSAGE,
} from "../../shared/domain/status-list-capacity.js";

/**
 * Refuse a status list capacity outside 1..MAX_STATUS_LIST_CAPACITY before
 * anything is allocated, also for a tenant default stored by an earlier
 * release.
 */
export function assertStatusListCapacity(size: number): void {
    if (!isStatusListCapacity(size)) {
        throw new BadRequestException(STATUS_LIST_CAPACITY_MESSAGE);
    }
}
