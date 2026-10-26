#!/usr/bin/env node
/**
 * Peak CPU and memory per container from `docker stats --format '{{json .}}'`
 * samples (one JSON object per line), as a Markdown table.
 *
 * Usage: node lib/resource-stats.mjs STATS.jsonl
 * Prints nothing when the file holds no samples.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Bytes per unit as docker prints them (binary and decimal prefixes). */
const UNIT_MIB = {
    B: 1 / 1048576,
    KiB: 1 / 1024,
    kB: 1000 / 1048576,
    KB: 1000 / 1048576,
    MiB: 1,
    MB: 1e6 / 1048576,
    GiB: 1024,
    GB: 1e9 / 1048576,
    TiB: 1048576,
};

/** "512.3MiB" → 512.3; unknown units give 0. */
export function toMiB(value) {
    const m = /([\d.]+)\s*([KMGT]?i?B|kB)/.exec(value ?? '');
    if (!m) return 0;
    return Number(m[1]) * (UNIT_MIB[m[2]] ?? 0);
}

/** Peak CPU (percent) and memory (MiB) per container name. */
export function peakUsage(text) {
    const peak = {};
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let s;
        try {
            s = JSON.parse(line);
        } catch {
            continue;
        }
        if (!s.Name) continue;
        const p = (peak[s.Name] ??= { cpu: 0, mem: 0, limit: '' });
        p.cpu = Math.max(p.cpu, Number.parseFloat(s.CPUPerc) || 0);
        const [used, limit] = String(s.MemUsage ?? '').split('/');
        p.mem = Math.max(p.mem, toMiB(used));
        p.limit = (limit ?? '').trim();
    }
    return peak;
}

export function resourceTableMarkdown(peak) {
    const rows = Object.entries(peak).sort(([a], [b]) => a.localeCompare(b));
    if (rows.length === 0) return '';
    return [
        '| Container | Peak CPU | Peak memory | Memory limit |',
        '| --- | ---: | ---: | --- |',
        ...rows.map(([name, p]) => `| ${name} | ${p.cpu.toFixed(0)} % | ${p.mem.toFixed(0)} MiB | ${p.limit} |`),
    ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const table = resourceTableMarkdown(peakUsage(readFileSync(process.argv[2], 'utf8')));
    if (table) console.log(table);
}
