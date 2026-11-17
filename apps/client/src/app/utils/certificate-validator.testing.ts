/**
 * Self-signed EC P-256 test root certificates, generated with
 * `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256`. Their
 * private keys were discarded.
 */

/** 372 bytes of DER, so its base64 has no `=` padding. */
export const TEST_ROOT_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBcDCCARagAwIBAgIBAjAKBggqhkjOPQQDAjAWMRQwEgYDVQQDDAtUZXN0IFJv
b3QgMjAgFw0yNjEwMTExNTMzNDhaGA8yMTI2MDkxNzE1MzM0OFowFjEUMBIGA1UE
AwwLVGVzdCBSb290IDIwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQTyHtAAE0N
qDbA5ysOM6+n17tWEpRulaL9+3Sy5kjFBzMD46Jqf3vgEeSznNDR9dngLFMp/q90
FAl7CoEGHHIzo1MwUTAdBgNVHQ4EFgQUVa3s4UnHg0m3cRrykmFdiordsckwHwYD
VR0jBBgwFoAUVa3s4UnHg0m3cRrykmFdiordsckwDwYDVR0TAQH/BAUwAwEB/zAK
BggqhkjOPQQDAgNIADBFAiAKwO1k+5bXg1nKPYLzmzPb2lBhE9SispS6AybaqUYc
SQIhAIYQ0jIYZKBMQri3AJ+rCW+KA/mLhBHRss2ZD9mH50Hc
-----END CERTIFICATE-----
`;

/** 373 bytes of DER, so its base64 ends in `=` padding. */
export const OTHER_TEST_ROOT_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBcTCCARagAwIBAgIBATAKBggqhkjOPQQDAjAWMRQwEgYDVQQDDAtUZXN0IFJv
b3QgMTAgFw0yNjEwMTExNTMzNDdaGA8yMTI2MDkxNzE1MzM0N1owFjEUMBIGA1UE
AwwLVGVzdCBSb290IDEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASyHx8GJ6iK
64uvPBPmVCkbyijIYDwxiEEa8F+2f+Z1bDxlXbbJCzDymOnlvzelvuO2WCKJcXVv
duiInkDg8LVBo1MwUTAdBgNVHQ4EFgQU/LWjfb+HTb53G1EaookSWd1i7zkwHwYD
VR0jBBgwFoAU/LWjfb+HTb53G1EaookSWd1i7zkwDwYDVR0TAQH/BAUwAwEB/zAK
BggqhkjOPQQDAgNJADBGAiEA8zzip6Me8B7o9ymeJuP0YaOqC0pktzFyLXE6y3+B
0l4CIQDEY25kkV3KYBFBANfV4GtHSzTQaPYt3pL8VsehHbOobg==
-----END CERTIFICATE-----
`;

/** The base64 DER body of a single PEM certificate. */
export function pemToBase64Der(pem: string): string {
  return pem
    .replace('-----BEGIN CERTIFICATE-----', '')
    .replace('-----END CERTIFICATE-----', '')
    .replace(/\s/g, '');
}
