/**
 * The certificate in a file as PEM: a PEM file as it is, a DER file
 * (.der, .cer, .crt) wrapped in a PEM block.
 */
export async function readCertificateFile(file: File): Promise<string> {
  const content = await file.arrayBuffer();
  const text = new TextDecoder().decode(content).trim();
  if (text.includes('-----BEGIN CERTIFICATE-----')) return text;

  const bytes = new Uint8Array(content);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  const base64 =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join('\n') || '';
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----`;
}

/** The certificates of the selected files as one PEM chain, in the order of the files. */
export async function readCertificateFiles(files: Iterable<File>): Promise<string> {
  const certificates = await Promise.all(Array.from(files, readCertificateFile));
  return certificates.join('\n');
}
