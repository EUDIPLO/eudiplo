import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
    SESSION_CANCELLED,
    SESSION_STATUS_CHANGED,
    type SessionCancellationPublisher,
    type SessionCancelledEvent,
    type SessionEventPublisher,
    type SessionStatusChangedEvent,
} from "../ports/session-event-publisher.js";

@Injectable()
export class NestSessionEventPublisher
    implements SessionEventPublisher, SessionCancellationPublisher
{
    constructor(private readonly emitter: EventEmitter2) {}

    publishStatusChanged(event: SessionStatusChangedEvent): void {
        this.emitter.emit(SESSION_STATUS_CHANGED, event);
    }

    publishCancelled(event: SessionCancelledEvent): void {
        this.emitter.emit(SESSION_CANCELLED, event);
    }
}
