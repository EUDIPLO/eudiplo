// Map k6 built-in modules to the Node stand-ins and give the scripts the
// __ENV global k6 provides. Loaded with `node --import`.
import { register } from 'node:module';

globalThis.__ENV = globalThis.__ENV ?? {};

register(
    `data:text/javascript,${encodeURIComponent(`
        const map = {
            'k6': ${JSON.stringify(new URL('./k6.mjs', import.meta.url).href)},
            'k6/encoding': ${JSON.stringify(new URL('./k6-encoding.mjs', import.meta.url).href)},
            'k6/http': ${JSON.stringify(new URL('./k6-http.mjs', import.meta.url).href)},
        };
        export async function resolve(specifier, context, next) {
            if (specifier in map) return { url: map[specifier], shortCircuit: true };
            return next(specifier, context);
        }
    `)}`,
);
