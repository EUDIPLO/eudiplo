import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { describe, test } from 'node:test';
import {
    addKeyBinding,
    encryptJwe,
    exportKeyPair,
    generateKeyPair,
    importPrivateKey,
    selectDisclosures,
} from '../lib/crypto.ts';
import {
    chooseEnc,
    requestedClaimPaths,
    selectCredentialQuery,
    stripKeyBinding,
} from '../lib/flows/presentation.ts';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const json64 = (o) => b64u(JSON.stringify(o));
const hash = (alg, s) => b64u(nodeCrypto.createHash(alg).update(s).digest());

/** Build an unsigned SD-JWT VC: { family_name, given_name, age_equal_or_over: { 18, 21 }, nationalities: [DE] }. */
function buildSdJwt({ sdAlg } = {}) {
    const nodeAlg = { undefined: 'sha256', 'sha-256': 'sha256', 'sha-384': 'sha384' }[String(sdAlg)];
    const disclosures = [];
    const disclose = (...parts) => {
        const d = json64([b64u(nodeCrypto.randomBytes(8)), ...parts]);
        disclosures.push(d);
        return hash(nodeAlg, d);
    };
    const age = { _sd: [disclose('18', true), disclose('21', true)] };
    const payload = {
        iss: 'https://issuer.example',
        vct: 'urn:test',
        plain: 'visible',
        nationalities: [{ '...': disclose('DE') }],
        _sd: [disclose('family_name', 'MUSTERMANN'), disclose('given_name', 'ERIKA'), disclose('age_equal_or_over', age)],
    };
    if (sdAlg) payload._sd_alg = sdAlg;
    const jwt = `${json64({ alg: 'ES256', typ: 'dc+sd-jwt' })}.${json64(payload)}.c2ln`;
    return { sdJwt: `${jwt}~${disclosures.join('~')}~`, nodeAlg };
}

function disclosedNames(presentation) {
    return presentation
        .split('~')
        .slice(1)
        .filter((p) => p && !p.includes('.'))
        .map((d) => JSON.parse(Buffer.from(d, 'base64url').toString()))
        .map((d) => d[1]);
}

describe('selectDisclosures', () => {
    test('discloses a nested claim together with its parent, nothing else', async () => {
        const { sdJwt } = buildSdJwt();
        const p = await selectDisclosures(sdJwt, [['age_equal_or_over', '18']]);
        assert.deepEqual(disclosedNames(p).sort(), ['18', 'age_equal_or_over']);
        assert.ok(p.endsWith('~'));
    });

    test('plain claims need no disclosure', async () => {
        const { sdJwt } = buildSdJwt();
        const p = await selectDisclosures(sdJwt, [['plain']]);
        assert.deepEqual(disclosedNames(p), []);
    });

    test('array elements are disclosed with a null path segment', async () => {
        const { sdJwt } = buildSdJwt();
        const p = await selectDisclosures(sdJwt, [['nationalities', null]]);
        assert.deepEqual(disclosedNames(p), ['DE']);
    });

    test('a numeric index discloses only that array element', async () => {
        const { sdJwt } = buildSdJwt();
        const p = await selectDisclosures(sdJwt, [['nationalities', 0]]);
        assert.deepEqual(disclosedNames(p), ['DE']);
    });

    test('an array segment on an object fails', async () => {
        const { sdJwt } = buildSdJwt();
        await assert.rejects(selectDisclosures(sdJwt, [['age_equal_or_over', null]]), /expects an array/);
    });

    test('a path below a scalar fails', async () => {
        const { sdJwt } = buildSdJwt();
        await assert.rejects(selectDisclosures(sdJwt, [['plain', 'x']]), /not found in credential/);
    });

    test('an unknown claim fails loudly', async () => {
        const { sdJwt } = buildSdJwt();
        await assert.rejects(selectDisclosures(sdJwt, [['address']]), /neither plain nor disclosable/);
    });

    test('digests follow the issuer _sd_alg', async () => {
        const { sdJwt } = buildSdJwt({ sdAlg: 'sha-384' });
        const p = await selectDisclosures(sdJwt, [['family_name']]);
        assert.deepEqual(disclosedNames(p), ['family_name']);
    });

    test('an unsupported _sd_alg is rejected', async () => {
        const { sdJwt } = buildSdJwt();
        const [h, payload, sig] = sdJwt.split('~')[0].split('.');
        const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
        body._sd_alg = 'md5';
        const tampered = sdJwt.replace(`${h}.${payload}.${sig}`, `${h}.${json64(body)}.${sig}`);
        await assert.rejects(selectDisclosures(tampered, [['family_name']]), /Unsupported _sd_alg/);
    });
});

describe('addKeyBinding', () => {
    for (const sdAlg of [undefined, 'sha-384']) {
        test(`signs aud, nonce and sd_hash (${sdAlg ?? 'default sha-256'})`, async () => {
            const { sdJwt, nodeAlg } = buildSdJwt({ sdAlg });
            const holder = await exportKeyPair(await generateKeyPair());
            const presentation = await selectDisclosures(sdJwt, [['given_name']]);
            const vp = await addKeyBinding(presentation, await importPrivateKey(holder.privateJwk), 'x509_san_dns:verifier', 'n-1');

            const kb = vp.slice(presentation.length);
            const [h, p, s] = kb.split('.');
            assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'kb+jwt', alg: 'ES256' });
            const payload = JSON.parse(Buffer.from(p, 'base64url'));
            assert.equal(payload.aud, 'x509_san_dns:verifier');
            assert.equal(payload.nonce, 'n-1');
            assert.equal(payload.sd_hash, hash(nodeAlg, presentation));

            const key = nodeCrypto.createPublicKey({ key: holder.publicJwk, format: 'jwk' });
            const valid = nodeCrypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
            assert.ok(valid, 'KB-JWT signature verifies with the holder key');
        });
    }
});

describe('encryptJwe', () => {
    function concatKdf(z, enc, bits) {
        const lp = (b) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
        const supp = Buffer.alloc(4);
        supp.writeUInt32BE(bits);
        return nodeCrypto
            .createHash('sha256')
            .update(Buffer.concat([Buffer.from([0, 0, 0, 1]), z, lp(Buffer.from(enc)), lp(Buffer.alloc(0)), lp(Buffer.alloc(0)), supp]))
            .digest()
            .subarray(0, bits / 8);
    }

    for (const enc of ['A128GCM', 'A256GCM']) {
        test(`ECDH-ES + ${enc} decrypts with the verifier key`, async () => {
            const verifier = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
            const jwk = { ...verifier.publicKey.export({ format: 'jwk' }), kid: 'k1' };
            const jwe = await encryptJwe({ vp_token: { q: ['x'] }, state: 's' }, jwk, enc);

            const [ph, ek, iv, ct, tag] = jwe.split('.');
            assert.equal(ek, '', 'direct key agreement has no encrypted key');
            const header = JSON.parse(Buffer.from(ph, 'base64url'));
            assert.equal(header.alg, 'ECDH-ES');
            assert.equal(header.enc, enc);
            assert.equal(header.kid, 'k1');

            const z = nodeCrypto.diffieHellman({
                privateKey: verifier.privateKey,
                publicKey: nodeCrypto.createPublicKey({ key: header.epk, format: 'jwk' }),
            });
            const bits = enc === 'A256GCM' ? 256 : 128;
            const d = nodeCrypto.createDecipheriv(`aes-${bits}-gcm`, concatKdf(z, enc, bits), Buffer.from(iv, 'base64url'));
            d.setAAD(Buffer.from(ph));
            d.setAuthTag(Buffer.from(tag, 'base64url'));
            const plain = Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
            assert.deepEqual(JSON.parse(plain), { vp_token: { q: ['x'] }, state: 's' });
        });
    }
});

describe('requestedClaimPaths', () => {
    test('without claim_sets every claim is requested', () => {
        const q = { id: 'q', format: 'dc+sd-jwt', claims: [{ path: ['a'] }, { path: ['b'] }] };
        assert.deepEqual(requestedClaimPaths(q), [['a'], ['b']]);
    });

    test('with claim_sets only the first satisfiable set is requested', () => {
        const q = {
            id: 'q',
            format: 'dc+sd-jwt',
            claims: [
                { id: 'a', path: ['a'] },
                { id: 'b', path: ['b'] },
                { id: 'c', path: ['c'] },
            ],
            claim_sets: [['x', 'a'], ['b'], ['a', 'c']],
        };
        assert.deepEqual(requestedClaimPaths(q), [['b']]);
    });

    test('claim_sets that reference no defined claim fail', () => {
        const q = { id: 'q', format: 'dc+sd-jwt', claims: [{ id: 'a', path: ['a'] }], claim_sets: [['x']] };
        assert.throws(() => requestedClaimPaths(q), /No claim set/);
    });
});

describe('wallet choices', () => {
    const ro = (enc) => ({ client_metadata: { encrypted_response_enc_values_supported: enc } });

    test('chooseEnc prefers A128GCM and falls back to A256GCM', () => {
        assert.equal(chooseEnc(ro(['A256GCM', 'A128GCM'])), 'A128GCM');
        assert.equal(chooseEnc(ro(['A256GCM'])), 'A256GCM');
        assert.equal(chooseEnc({}), 'A128GCM');
        assert.throws(() => chooseEnc(ro(['A192GCM'])), /none of A128GCM\/A256GCM/);
    });

    const dcql = {
        dcql_query: {
            credentials: [
                { id: 'mdoc', format: 'mso_mdoc' },
                { id: 'a', format: 'dc+sd-jwt' },
                { id: 'b', format: 'dc+sd-jwt' },
            ],
        },
    };

    test('selectCredentialQuery takes the first dc+sd-jwt query', () => {
        globalThis.__ENV = {};
        assert.equal(selectCredentialQuery(dcql).id, 'a');
    });

    test('selectCredentialQuery honours DCQL_CREDENTIAL_ID', () => {
        globalThis.__ENV = { DCQL_CREDENTIAL_ID: 'b' };
        try {
            assert.equal(selectCredentialQuery(dcql).id, 'b');
        } finally {
            globalThis.__ENV = {};
        }
    });

    test('selectCredentialQuery fails without a dc+sd-jwt query', () => {
        globalThis.__ENV = {};
        assert.throws(
            () => selectCredentialQuery({ dcql_query: { credentials: [{ id: 'mdoc', format: 'mso_mdoc' }] } }),
            /No dc\+sd-jwt credential query/,
        );
    });

    test('stripKeyBinding drops a trailing KB-JWT and keeps the trailing ~', () => {
        assert.equal(stripKeyBinding('h.p.s~d1~d2~k.b.j'), 'h.p.s~d1~d2~');
        assert.equal(stripKeyBinding('h.p.s~d1~'), 'h.p.s~d1~');
        assert.equal(stripKeyBinding('h.p.s'), 'h.p.s~');
    });
});
