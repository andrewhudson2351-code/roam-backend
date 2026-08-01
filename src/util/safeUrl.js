// SSRF guard for user-supplied URLs (venue.website). Two layers:
//   isPublicHttpUrl(raw)      — cheap synchronous format/host check for
//                               create/patch: http(s) only, no private/
//                               loopback/link-local/metadata literal hosts.
//   assertPublicUrlAtFetch(raw) — async re-resolve of the hostname right
//                               before fetching, so a name that looked public
//                               at write time can't point at a private IP at
//                               fetch time (DNS rebinding). Throws if unsafe.
const dns = require("dns").promises;
const net = require("net");

// Private / loopback / link-local / CGNAT / metadata + IPv6 equivalents.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;                       // loopback
    if (a === 0) return true;                         // "this host"
    if (a === 169 && b === 254) return true;          // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;          // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true;// 100.64/10 CGNAT
    return false;
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::1" || v6 === "::") return true;                 // loopback / unspecified
  if (v6.startsWith("fe80")) return true;                       // link-local
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true;  // unique-local
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));// IPv4-mapped
  return false;
}

function parseHttpUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u;
}

// Synchronous, best-effort: rejects the obvious stuff at write time. A bare
// hostname that resolves privately is caught later by assertPublicUrlAtFetch.
function isPublicHttpUrl(raw) {
  const u = parseHttpUrl(raw);
  if (!u) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  if (net.isIP(host) && isPrivateIp(host)) return false;
  return true;
}

// Async, authoritative: resolve every A/AAAA and reject if ANY is private.
// Call this immediately before fetch(). Throws on unsafe/unresolvable.
async function assertPublicUrlAtFetch(raw) {
  const u = parseHttpUrl(raw);
  if (!u) throw new Error("url not http(s)");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("host not permitted");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("host resolves to a private range");
    return u.href;
  }
  const results = await dns.lookup(host, { all: true });
  if (!results.length) throw new Error("host did not resolve");
  for (const { address } of results) {
    if (isPrivateIp(address)) throw new Error("host resolves to a private range");
  }
  return u.href;
}

module.exports = { isPublicHttpUrl, assertPublicUrlAtFetch, isPrivateIp };
