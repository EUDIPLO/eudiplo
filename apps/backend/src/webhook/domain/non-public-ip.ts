import { BlockList, isIP } from "node:net";

/**
 * Special-purpose ranges of the IANA address registries, plus multicast and
 * reserved space. Outbound requests must not reach them unless private
 * networks are allowed. The IETF protocol assignment blocks are blocked as a
 * whole, including their few globally reachable anycast entries.
 */
const NON_PUBLIC = new BlockList();

for (const [network, prefix] of [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // carrier-grade NAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local, cloud metadata
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // documentation
    ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // documentation
    ["203.0.113.0", 24], // documentation
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved, broadcast
] as const) {
    NON_PUBLIC.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
    ["::", 96], // unspecified, loopback, IPv4-compatible (deprecated)
    ["::ffff:0:0:0", 96], // IPv4-translated
    ["64:ff9b:1::", 48], // local-use NAT64
    ["100::", 64], // discard-only
    ["2001::", 23], // IETF protocol assignments, including Teredo
    ["2001:db8::", 32], // documentation
    ["3fff::", 20], // documentation
    ["5f00::", 16], // SRv6 SIDs
    ["fc00::", 7], // unique local
    ["fe80::", 10], // link-local
    ["fec0::", 10], // site-local (deprecated)
    ["ff00::", 8], // multicast
] as const) {
    NON_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** The eight 16-bit groups of a valid IPv6 address. */
function ipv6Groups(address: string): number[] {
    let text = address.split("%")[0].toLowerCase();
    const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
    if (dotted) {
        const [a, b, c, d] = dotted.slice(2).map(Number);
        text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const [head, tail] = text.split("::");
    const parse = (part: string | undefined) =>
        part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
    const left = parse(head);
    const right = parse(tail);
    const zeros = text.includes("::") ? 8 - left.length - right.length : 0;
    return [...left, ...new Array<number>(zeros).fill(0), ...right];
}

/**
 * IPv4 address that an IPv6 address carries and is routed to: IPv4-mapped
 * (`::ffff:0:0/96`), NAT64 with the well-known prefix (`64:ff9b::/96`) and
 * 6to4 (`2002::/16`).
 */
function embeddedIpv4(groups: number[]): string | undefined {
    const ipv4 = (high: number, low: number) =>
        [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    const zero = (from: number, to: number) =>
        groups.slice(from, to).every((group) => group === 0);
    if (zero(0, 5) && groups[5] === 0xffff) return ipv4(groups[6], groups[7]);
    if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) {
        return ipv4(groups[6], groups[7]);
    }
    if (groups[0] === 0x2002) return ipv4(groups[1], groups[2]);
    return undefined;
}

/**
 * Whether an outbound request must not connect to this address: anything
 * that is not a public unicast address, including IPv6 forms that route to
 * a non-public IPv4 address. Strings that are no IP address count as
 * non-public, so callers fail closed.
 */
export function isNonPublicIp(address: string): boolean {
    const version = isIP(address);
    if (version === 4) return NON_PUBLIC.check(address, "ipv4");
    if (version !== 6) return true;
    const ipv4 = embeddedIpv4(ipv6Groups(address));
    if (ipv4 !== undefined) return NON_PUBLIC.check(ipv4, "ipv4");
    // BlockList does not parse every form with a zone ID that isIP accepts,
    // and returns false (public) for those.
    return NON_PUBLIC.check(address.split("%")[0], "ipv6");
}
