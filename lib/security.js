// Shared security helpers for the API endpoints:
// SSRF-safe fetching, CORS, and rate limiting.

import dns from 'node:dns/promises';
import net from 'node:net';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ── SSRF protection ────────────────────────────────────────────────────────────

export class SsrfError extends Error {}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) + (parseInt(oct, 10) & 0xff)) >>> 0, 0);
}

function inV4Cidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// Loopback, private (RFC1918), link-local (incl. cloud metadata 169.254.169.254),
// CGNAT, benchmarking, multicast, and reserved ranges.
const V4_BLOCKED = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

function isPrivateV4(ip) {
  return V4_BLOCKED.some(([base, bits]) => inV4Cidr(ip, base, bits));
}

// Expand any IPv6 literal (incl. :: compression and embedded IPv4) to 8 hextets.
function expandV6(input) {
  let s = input.split('%')[0]; // strip zone id

  // Convert a trailing dotted-quad (e.g. ::ffff:127.0.0.1) into two hextets.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const dotted = s.slice(lastColon + 1).split('.').map(n => parseInt(n, 10));
    if (dotted.length === 4 && dotted.every(n => n >= 0 && n <= 255)) {
      const hi = ((dotted[0] << 8) | dotted[1]).toString(16);
      const lo = ((dotted[2] << 8) | dotted[3]).toString(16);
      s = s.slice(0, lastColon + 1) + hi + ':' + lo;
    }
  }

  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const parts = halves.length > 1
    ? [...head, ...Array(missing).fill('0'), ...tail]
    : head;
  if (parts.length !== 8) return null;
  return parts.map(h => parseInt(h || '0', 16) & 0xffff);
}

function isPrivateV6(ip) {
  const h = expandV6(ip);
  if (!h) return true; // unparseable → block
  const allZeroExceptLast = h.slice(0, 7).every(x => x === 0);
  if (allZeroExceptLast && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
  if (h.slice(0, 5).every(x => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    const v4 = `${(h[6] >> 8) & 0xff}.${h[6] & 0xff}.${(h[7] >> 8) & 0xff}.${h[7] & 0xff}`;
    return isPrivateV4(v4);
  }
  return false;
}

export function isBlockedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not a valid IP literal → block
}

// Resolve a hostname and reject if any resolved address is private/reserved.
// DNS resolution errors are allowed to propagate (they are not SsrfError).
export async function assertHostAllowed(hostname) {
  const host = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  let ips;
  if (net.isIP(host)) {
    ips = [host];
  } else {
    const resolved = await dns.lookup(host, { all: true });
    ips = resolved.map(r => r.address);
  }
  if (ips.length === 0) throw new SsrfError('Host did not resolve to any address');
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw new SsrfError('Target resolves to a private or reserved address');
    }
  }
}

// fetch() that validates the host (and every redirect hop) against the SSRF
// blocklist, enforces http/https, and applies a timeout. Redirects are followed
// manually so each Location is re-validated before it is requested.
export async function safeFetch(rawUrl, { timeout = 8000, headers = {}, maxRedirects = 5 } = {}) {
  let url = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new SsrfError('Only http and https URLs are supported');
    }
    await assertHostAllowed(parsed.hostname);

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal, redirect: 'manual', headers });
    } finally {
      clearTimeout(id);
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).href;
      continue;
    }
    return res;
  }
  throw new SsrfError('Too many redirects');
}

// ── CORS ───────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
  'https://rdrewj.com',
  'https://www.rdrewj.com',
]);

// Same-origin requests from the site are unaffected (CORS does not apply to them).
// Cross-origin callers only get an allow header if their origin is allowlisted.
export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Rate limiting ───────────────────────────────────────────────────────────────

// Per-instance fallback so limits never silently disappear if Upstash is
// unconfigured. It is best-effort (not shared across serverless instances),
// but it guarantees a ceiling instead of failing open.
const memoryHits = new Map();

function memoryLimit(key, requests, windowMs) {
  const now = Date.now();
  const recent = (memoryHits.get(key) || []).filter(t => now - t < windowMs);
  recent.push(now);
  memoryHits.set(key, recent);
  return recent.length <= requests;
}

export function makeRateLimiter({ requests, window, windowMs, prefix }) {
  let upstash = null;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    upstash = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(requests, window), prefix });
  }
  return {
    async check(key) {
      if (upstash) {
        const { success } = await upstash.limit(key);
        return success;
      }
      return memoryLimit(`${prefix}:${key}`, requests, windowMs);
    },
  };
}

export function getClientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

export function isBypassIp(ip) {
  const bypass = process.env.RATE_LIMIT_BYPASS_IP;
  return Boolean(bypass) && ip === bypass;
}
