import {
    type MiddlewareConsumer,
    Module,
    type NestModule,
} from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { runWithLogContext } from "./log-context.js";

/** Gives every HTTP request its own log context, see {@link runWithLogContext}. */
@Module({})
export class LogContextModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
        consumer
            .apply((_req: Request, _res: Response, next: NextFunction) =>
                runWithLogContext(next),
            )
            .forRoutes("*splat");
    }
}
