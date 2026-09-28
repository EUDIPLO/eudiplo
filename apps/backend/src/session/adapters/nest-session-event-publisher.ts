import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
    SESSION_STATUS_CHANGED,
    type SessionEventPublisher,
    type SessionStatusChangedEvent,
} from "../ports/session-event-publisher.js";

@Injectable()
export class NestSessionEventPublisher implements SessionEventPublisher {
    constructor(private readonly emitter: EventEmitter2) {}

    publishStatusChanged(event: SessionStatusChangedEvent): void {
        this.emitter.emit(SESSION_STATUS_CHANGED, event);
    }
}
