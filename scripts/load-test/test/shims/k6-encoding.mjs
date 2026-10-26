// Node stand-in for k6/encoding, enough for lib/crypto.ts.
function toBuffer(input) {
    if (typeof input === 'string') return Buffer.from(input, 'utf8');
    if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}
const NODE_ENCODING = { std: 'base64', rawstd: 'base64', url: 'base64url', rawurl: 'base64url' };
function b64encode(input, encoding = 'std') {
    let out = toBuffer(input).toString(NODE_ENCODING[encoding] ?? 'base64');
    if (encoding === 'rawstd') out = out.replace(/=+$/, '');
    return out;
}
function b64decode(input, encoding = 'std', format) {
    const buf = Buffer.from(input, NODE_ENCODING[encoding] ?? 'base64');
    if (format === 's') return buf.toString('utf8');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
export default { b64encode, b64decode };
export { b64encode, b64decode };
