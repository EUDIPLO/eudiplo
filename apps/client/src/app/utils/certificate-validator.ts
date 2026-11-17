import { AbstractControl, ValidationErrors } from '@angular/forms';

// A quick shape check before the request; the backend parses the certificate
// in full where it uses it and reports what is wrong with it.

const PEM_BEGIN = '-----BEGIN CERTIFICATE-----';
const PEM_END = '-----END CERTIFICATE-----';

const DER_SEQUENCE = 0x30;
const DER_BIT_STRING = 0x03;

/**
 * The bodies of the PEM certificate blocks in `value`, or the whole value when
 * it has none. Undefined when anything but whitespace is outside the blocks or
 * a block is not closed. Searches with indexOf, not a regular expression, so
 * the time stays linear in the length of the value.
 */
function pemBodies(value: string): string[] | undefined {
  if (!value.includes(PEM_BEGIN)) return [value];
  const bodies: string[] = [];
  let offset = 0;
  while (true) {
    const begin = value.indexOf(PEM_BEGIN, offset);
    if (value.slice(offset, begin === -1 ? undefined : begin).trim()) return undefined;
    if (begin === -1) return bodies;
    const end = value.indexOf(PEM_END, begin + PEM_BEGIN.length);
    if (end === -1) return undefined;
    bodies.push(value.slice(begin + PEM_BEGIN.length, end));
    offset = end + PEM_END.length;
  }
}

/** The tag of the DER element at `offset` and where its content starts and ends. */
function readDerElement(
  der: Uint8Array,
  offset: number,
  limit: number
): { tag: number; start: number; end: number } | undefined {
  if (offset + 2 > limit) return undefined;
  let length = der[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    // Long form. DER has no indefinite length (0x80), and four length bytes
    // are more than any certificate needs.
    const lengthBytes = length & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || start + lengthBytes > limit) return undefined;
    length = 0;
    for (let i = 0; i < lengthBytes; i++) {
      length = length * 256 + der[start + i];
    }
    start += lengthBytes;
  }
  const end = start + length;
  return end <= limit ? { tag: der[offset], start, end } : undefined;
}

/**
 * Walks DER bytes that hold X.509 certificates one after the other. Each must
 * have the outer shape of RFC 5280, section 4.1: a SEQUENCE of tbsCertificate
 * (SEQUENCE), signatureAlgorithm (SEQUENCE) and signatureValue (BIT STRING).
 * Returns the first certificate and how many there are, or undefined for
 * anything else.
 */
function readDerCertificates(der: Uint8Array): { first: Uint8Array; count: number } | undefined {
  let first: Uint8Array | undefined;
  let count = 0;
  let offset = 0;
  while (offset < der.length) {
    const certificate = readDerElement(der, offset, der.length);
    if (certificate?.tag !== DER_SEQUENCE) return undefined;
    let field = certificate.start;
    for (const tag of [DER_SEQUENCE, DER_SEQUENCE, DER_BIT_STRING]) {
      const element = readDerElement(der, field, certificate.end);
      if (element?.tag !== tag) return undefined;
      field = element.end;
    }
    if (field !== certificate.end) return undefined;
    first ??= der.subarray(offset, certificate.end);
    count++;
    offset = certificate.end;
  }
  return first ? { first, count } : undefined;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Reads the X.509 certificates in a value of PEM blocks or base64 DER: the
 * first one as base64 DER, and how many there are. PEM blocks may only be
 * separated by whitespace; base64 may contain line breaks. Two base64 DER
 * certificates written one after the other count as two when the first has no
 * `=` padding, and are malformed otherwise. Returns undefined when the value is
 * empty or not made of certificates. Only the outer structure of each
 * certificate is checked.
 */
function readCertificates(value: string): { first: string; count: number } | undefined {
  const bodies = pemBodies(value);
  if (!bodies) return undefined;
  let first: string | undefined;
  let count = 0;
  for (const body of bodies) {
    const base64 = body.replace(/\s/g, '');
    if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
      return undefined;
    }
    const certificates = readDerCertificates(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    if (!certificates) return undefined;
    first ??= toBase64(certificates.first);
    count += certificates.count;
  }
  return first ? { first, count } : undefined;
}

/**
 * The base64 DER of a certificate in base64 DER or PEM, the form the backend
 * stores. Send this instead of the raw value of a field that
 * `certificateValidator` accepted.
 */
export function certificateBase64(value: string): string {
  return readCertificates(value)?.first ?? value;
}

/**
 * Accepts exactly one X.509 certificate in base64 DER or PEM, by the rule the
 * backend applies to x509 trusted authorities. It checks the outer structure
 * of the certificate, not its contents. An empty value passes, so combine it
 * with `Validators.required`. The error keys are `certificate` for a value
 * that is not a certificate and `multipleCertificates` (with the `count`) for
 * a chain or several certificates.
 */
export function certificateValidator(control: AbstractControl): ValidationErrors | null {
  const value = `${control.value ?? ''}`;
  if (!value) return null;
  const certificates = readCertificates(value);
  if (!certificates) return { certificate: true };
  return certificates.count > 1 ? { multipleCertificates: { count: certificates.count } } : null;
}
