/**
 * Pre-seed the database with sessions before measuring.
 *
 * A fresh stack has empty session tables, so queries that scan or index
 * sessions look fast until production data accumulates. With
 * SEED_SESSIONS=N, setup() creates N sessions (half issuance offers, half
 * presentation requests) in parallel batches before the measured run starts.
 * The seeded sessions are never redeemed, like abandoned QR codes.
 *
 * Requests are tagged `stage:seed`, so they do not count against the
 * per-stage thresholds.
 */

import http from 'k6/http';
import { envNumber } from '../helpers.ts';
import type { FlowContext } from './context.ts';
import { issuanceOfferBody } from './issuance.ts';
import { presentationOfferBody } from './presentation.ts';

export function seedSessions(ctx: FlowContext, adminToken: string): void {
    const total = envNumber('SEED_SESSIONS', 0);
    if (total <= 0) return;
    const batchSize = Math.max(1, envNumber('SEED_BATCH_SIZE', 50));

    const params = {
        headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
        },
        tags: { stage: 'seed' },
    };
    // The same request bodies as the measured flows, so seeded sessions look
    // like real ones.
    const issuanceOffer = JSON.stringify(issuanceOfferBody(ctx));
    const presentationOffer = JSON.stringify(presentationOfferBody(ctx));

    let created = 0;
    let failed = 0;
    const started = Date.now();
    while (created + failed < total) {
        const n = Math.min(batchSize, total - created - failed);
        const requests = [];
        for (let i = 0; i < n; i++) {
            const issuance = (created + failed + i) % 2 === 0;
            requests.push({
                method: 'POST',
                url: issuance ? `${ctx.baseUrl}/api/issuer/offer` : `${ctx.baseUrl}/api/verifier/offer`,
                body: issuance ? issuanceOffer : presentationOffer,
                params,
            });
        }
        for (const res of http.batch(requests)) {
            if (res.status === 201) created++;
            else failed++;
        }
    }

    console.log(
        `Seeded ${created} sessions in ${((Date.now() - started) / 1000).toFixed(1)} s` +
            (failed ? ` (${failed} failed)` : ''),
    );
    if (failed > total * 0.01) {
        throw new Error(`Seeding failed for ${failed} of ${total} sessions`);
    }
}
