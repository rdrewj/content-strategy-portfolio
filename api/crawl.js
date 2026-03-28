import * as cheerio from 'cheerio';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

function getRatelimiter() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(3, '1 d'),
    prefix: 'csx-crawl',
  });
}

async function fetchWithTimeout(url, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'CSX-Audit-Bot/1.0 (content strategy analysis tool)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    return response;
  } finally {
    clearTimeout(id);
  }
}

async function fetchRobotsTxt(baseUrl) {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const res = await fetchWithTimeout(robotsUrl, 4000);
    if (!res.ok) return [];
    const text = await res.text();
    const disallowed = [];
    let applicableAgent = false;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('User-agent:')) {
        const agent = trimmed.replace('User-agent:', '').trim();
        applicableAgent = agent === '*' || agent.toLowerCase() === 'csx-audit-bot';
      }
      if (applicableAgent && trimmed.startsWith('Disallow:')) {
        const path = trimmed.replace('Disallow:', '').trim();
        if (path) disallowed.push(path);
      }
    }
    return disallowed;
  } catch {
    return [];
  }
}

function isDisallowed(urlPath, disallowedPaths) {
  return disallowedPaths.some(d => d !== '/' && urlPath.startsWith(d));
}

function classifyPageType(url, headings) {
  const path = new URL(url).pathname.toLowerCase();
  if (path === '/' || path === '') return 'homepage';
  if (/\/about/.test(path)) return 'about';
  if (/\/contact/.test(path)) return 'contact';
  if (/\/(blog|post|article|news)/.test(path)) return 'blog_post';
  if (/\/(product|service|solution|feature|offering)/.test(path)) return 'product_service';
  if (/\/(case-stud|portfolio|work|project)/.test(path)) return 'case_study';
  if (/\/(pricing|price|plan|tier)/.test(path)) return 'pricing';
  if (/\/(faq|help|support|docs|documentation)/.test(path)) return 'support';
  if (/\/(legal|privacy|terms|cookie|accessibility)/.test(path)) return 'legal';
  if (/\/(tool|calculator|generator|audit)/.test(path)) return 'tool';
  return 'landing_page';
}

const CTA_VERBS = [
  'get', 'start', 'try', 'sign', 'download', 'learn', 'view', 'see',
  'request', 'contact', 'join', 'subscribe', 'book', 'schedule', 'explore',
  'discover', 'watch', 'read', 'apply', 'register', 'buy', 'shop', 'order',
];

function extractCtaElements($, url) {
  const ctas = [];
  $('button').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 60) ctas.push({ type: 'button', text });
  });
  $('a').each((_, el) => {
    const $el = $(el);
    const rawText = $el.text().trim();
    if (!rawText || rawText.length > 60) return;
    const text = rawText.toLowerCase();
    const href = $el.attr('href') || '';
    const cls = ($el.attr('class') || '').toLowerCase();
    const isCTAClass = /btn|button|cta|action|primary|secondary/.test(cls);
    const isCTAText = CTA_VERBS.some(v => text.startsWith(v));
    const isContactLink = href.startsWith('mailto:') || href.startsWith('tel:');
    if (isCTAClass || isCTAText || isContactLink) {
      ctas.push({ type: 'link', text: rawText, href });
    }
  });
  return ctas.slice(0, 10);
}

function extractPageData(url, html) {
  const $ = cheerio.load(html);

  $('script, style, noscript, template').remove();

  const title = $('title').text().trim() || '(no title)';
  const metaDesc =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    null;

  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    const text = $(el).text().trim();
    if (text) headings.push({ level: parseInt(el.tagName[1]), text });
  });

  const navLinks = [];
  $('nav a[href], [role="navigation"] a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && text) {
      try {
        navLinks.push({ url: new URL(href, url).href, text });
      } catch {}
    }
  });

  const ctaElements = extractCtaElements($, url);

  // Strip nav/header/footer for body text extraction
  $('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000);
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  const outboundLinks = [];
  const baseHost = new URL(url).hostname;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (!href) return;
    try {
      const resolved = new URL(href, url);
      if (resolved.hostname === baseHost && resolved.href !== url) {
        outboundLinks.push({ url: resolved.href, text });
      }
    } catch {}
  });

  const pageType = classifyPageType(url, headings);

  return {
    url,
    title,
    meta_description: metaDesc,
    headings,
    body_text: bodyText,
    word_count: wordCount,
    outbound_links: outboundLinks,
    nav_links: navLinks,
    cta_elements: ctaElements,
    page_type: pageType,
    is_in_nav: false,
    in_degree: 0,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting
  const ratelimiter = getRatelimiter();
  if (ratelimiter) {
    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      '127.0.0.1';
    if (ip !== '98.248.164.96') {
      const { success } = await ratelimiter.limit(ip);
      if (!success) {
        return res.status(429).json({
          error: 'You have run 3 audits today. The limit resets after 24 hours.',
        });
      }
    }
  }

  const { url, max_pages = 10 } = req.body || {};

  if (!url) return res.status(400).json({ error: 'URL is required' });

  let parsedUrl;
  try {
    parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
    const h = parsedUrl.hostname;
    if (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '0.0.0.0' ||
      h === '::1' ||
      h.startsWith('192.168.') ||
      h.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    ) {
      return res.status(400).json({ error: 'Private or local URLs are not supported' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL. Please include a valid domain (e.g. https://example.com)' });
  }

  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const limit = Math.min(Math.max(1, max_pages), 10);

  const disallowedPaths = await fetchRobotsTxt(baseUrl);

  // BFS crawl
  const visited = new Set();
  const queue = [parsedUrl.href];
  const pages = [];
  const linkGraph = [];
  let isSpa = false;

  while (queue.length > 0 && pages.length < limit) {
    const currentUrl = queue.shift();
    const normalized = currentUrl.split('#')[0].replace(/\/$/, '') || baseUrl;

    if (visited.has(normalized)) continue;
    visited.add(normalized);

    const urlPath = new URL(normalized).pathname;
    if (isDisallowed(urlPath, disallowedPaths)) continue;

    let html;
    try {
      const response = await fetchWithTimeout(normalized);
      if (!response.ok) continue;
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes('text/html')) continue;
      html = await response.text();
    } catch {
      continue;
    }

    // SPA detection on first page
    if (pages.length === 0) {
      const visibleText = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      const hasFramework = /<div[^>]+id=["'](root|app|__next|gatsby-focus-wrapper)["']/.test(html);
      isSpa = visibleText.length < 800 && hasFramework;
    }

    const pageData = extractPageData(normalized, html);

    for (const link of pageData.outbound_links) {
      const linkNorm = link.url.split('#')[0].replace(/\/$/, '') || link.url;
      linkGraph.push({
        from_url: normalized,
        to_url: link.url,
        anchor_text: link.text,
        is_nav_link: pageData.nav_links.some(nl => nl.url === link.url),
      });
      if (!visited.has(linkNorm)) queue.push(link.url);
    }

    pages.push(pageData);
  }

  // Compute in-degree
  const pageUrls = new Set(pages.map(p => p.url));
  const inDegree = {};
  for (const p of pages) inDegree[p.url] = 0;
  for (const edge of linkGraph) {
    const norm = edge.to_url.split('#')[0].replace(/\/$/, '') || edge.to_url;
    if (norm in inDegree) inDegree[norm]++;
    else if (edge.to_url in inDegree) inDegree[edge.to_url]++;
  }

  // Mark nav membership
  const navUrls = new Set(
    linkGraph.filter(e => e.is_nav_link).map(e => e.to_url.split('#')[0].replace(/\/$/, ''))
  );
  for (const page of pages) {
    const norm = page.url.split('#')[0].replace(/\/$/, '');
    page.is_in_nav = navUrls.has(norm) || navUrls.has(page.url);
    page.in_degree = inDegree[page.url] || inDegree[page.url.replace(/\/$/, '')] || 0;
  }

  const navStructure = (pages[0]?.nav_links || []).slice(0, 20);

  return res.status(200).json({
    root_url: baseUrl,
    crawled_at: new Date().toISOString(),
    pages_found: pages.length,
    is_spa: isSpa,
    spa_warning: isSpa
      ? 'This appears to be a JavaScript-rendered app. The crawler cannot execute JavaScript, so content may be incomplete. Results will be partial.'
      : null,
    pages,
    link_graph: linkGraph,
    nav_structure: navStructure,
    robots_disallowed: disallowedPaths.length > 0 ? disallowedPaths : null,
  });
}
