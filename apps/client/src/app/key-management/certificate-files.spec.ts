import { describe, expect, it } from 'vitest';
import { readCertificateFile, readCertificateFiles } from './certificate-files';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

describe('certificate files', () => {
  it('returns a PEM file trimmed', async () => {
    expect(await readCertificateFile(new File([`\n${PEM}\n\n`], 'leaf.pem'))).toBe(PEM);
  });

  it('wraps a DER file in a PEM block of 64-character lines', async () => {
    const der = Uint8Array.from({ length: 100 }, (_, i) => i);

    const pem = await readCertificateFile(new File([der], 'leaf.der'));

    const lines = pem.split('\n');
    expect(lines[0]).toBe('-----BEGIN CERTIFICATE-----');
    expect(lines.at(-1)).toBe('-----END CERTIFICATE-----');
    expect(lines.slice(1, -1).every((line) => line.length <= 64)).toBe(true);
    const decoded = Uint8Array.from(atob(lines.slice(1, -1).join('')), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(der);
  });

  it('joins several files in their order', async () => {
    const intermediate = PEM.replace('MIIB', 'MIIC');

    expect(
      await readCertificateFiles([new File([PEM], 'leaf.pem'), new File([intermediate], 'ca.pem')])
    ).toBe(`${PEM}\n${intermediate}`);
  });
});
