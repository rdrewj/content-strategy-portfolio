import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeIAMetrics(pages, linkGraph) {
  // Orphaned pages: in-degree 0 and not homepage
  const orphaned = pages.filter(p => p.in_degree === 0 && p.page_type !== 'homepage');

  // BFS depth from root
  const rootUrl = pages[0]?.url;
  const depth = rootUrl ? { [rootUrl]: 0 } : {};
  const queue = rootUrl ? [rootUrl] : [];
  while (queue.length) {
    const cur = queue.shift();
    const neighbors = linkGraph.filter(e => e.from_url === cur).map(e => e.to_url);
    for (const n of neighbors) {
      if (!(n in depth)) {
        depth[n] = depth[cur] + 1;
        queue.push(n);
      }
    }
  }

  const deepPages = pages.filter(p => (depth[p.url] || 0) >= 3 && p.word_count > 80);

  // Category groups by first URL path segment
  const categories = {};
  for (const p of pages) {
    const segs = new URL(p.url).pathname.split('/').filter(Boolean);
    const cat = segs[0] || 'root';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(p.url);
  }

  // Dead ends: no outbound links pointing to other crawled pages
  const pageUrls = new Set(pages.map(p => p.url));
  const deadEnds = pages.filter(p => {
    const internal = linkGraph.filter(
      e => e.from_url === p.url && pageUrls.has(e.to_url)
    );
    return internal.length === 0 && !['contact', 'legal'].includes(p.page_type);
  });

  return { orphaned, deepPages, categories, deadEnds, depth };
}

function scoreFindings(findings, highWeight = 22, medWeight = 10, lowWeight = 4) {
  if (findings.length === 0) return 88; // no findings = good, not perfect
  const high = findings.filter(f => f.severity === 'high').length;
  const med = findings.filter(f => f.severity === 'medium').length;
  const low = findings.filter(f => f.severity === 'low').length;

  // Diminishing returns after 3+ findings of same severity
  const highScore = high <= 3 ? high * highWeight : 3 * highWeight + (high - 3) * 8;
  const medScore = med <= 3 ? med * medWeight : 3 * medWeight + (med - 3) * 4;

  return Math.max(20, Math.min(88, 100 - highScore - medScore - low * lowWeight));
}

async function callClaude(model, prompt, maxTokens) {
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = resp.content[0]?.text || '[]';
  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ── Analysis modules ──────────────────────────────────────────────────────────

async function compressPages(pages) {
  const pagesText = pages
    .map(
      (p, i) => `[Page ${i + 1}]
URL: ${p.url}
Title: ${p.title}
Type: ${p.page_type}
Headings: ${p.headings.map(h => `H${h.level}: ${h.text}`).join(' | ') || 'none'}
CTAs: ${p.cta_elements.map(c => c.text).join(', ') || 'none'}
Body excerpt: ${p.body_text.slice(0, 600)}`
    )
    .join('\n\n---\n\n');

  const result = await callClaude(
    'claude-haiku-4-5-20251001',
    `Analyze these ${pages.length} web pages and return a JSON array — one object per page, in order.

${pagesText}

Each object:
{
  "url": "page url",
  "primary_topic": "one sentence: what this page is for",
  "key_entities": ["up to 6 key topics, concepts, or named entities"],
  "audience_signals": "who this seems written for (one phrase)",
  "tone_markers": ["3-5 words describing the writing style"],
  "open_questions": ["up to 3 questions this page raises but doesn't answer"],
  "has_clear_purpose": true or false
}

Return only the JSON array.`,
    2000
  );

  if (Array.isArray(result)) return result;
  // Fallback
  return pages.map(p => ({
    url: p.url,
    primary_topic: p.title,
    key_entities: [],
    audience_signals: 'unknown',
    tone_markers: ['unknown'],
    open_questions: [],
    has_clear_purpose: true,
  }));
}

async function analyzeIA(pages, linkGraph, iaMetrics, sitePurpose) {
  const navTree = pages
    .filter(p => p.is_in_nav || p.page_type === 'homepage')
    .map(p => `  ${p.page_type}: ${p.url} — "${p.title}"`)
    .join('\n') || '  (no navigation detected)';

  const orphanedStr =
    iaMetrics.orphaned.map(p => `  ${p.url} (${p.page_type}, ${p.word_count} words)`).join('\n') ||
    '  none';

  const deepStr =
    iaMetrics.deepPages
      .map(p => `  ${p.url} (depth: ${iaMetrics.depth[p.url] || '?'}, ${p.word_count} words)`)
      .join('\n') || '  none';

  const catStr = Object.entries(iaMetrics.categories)
    .map(([cat, urls]) => `  /${cat}: ${urls.length} page(s)`)
    .join('\n');

  const pageTypeStr = pages.map(p => `  ${p.page_type}: ${p.url}`).join('\n');

  const result = await callClaude(
    'claude-sonnet-4-6',
    `You are a content strategist auditing information architecture.

Site purpose: ${sitePurpose || 'infer from the pages below'}

Navigation structure:
${navTree}

All pages by type:
${pageTypeStr}

Orphaned pages (no inbound links):
${orphanedStr}

Pages 3+ clicks from homepage:
${deepStr}

Content categories by URL structure:
${catStr}

Identify real IA problems. If the IA is solid, return fewer findings with lower severity. Don't fabricate issues.

Return a JSON array of findings:
[{
  "title": "concise title",
  "severity": "high|medium|low",
  "affected_urls": ["url"],
  "description": "what the problem is and why it matters for users",
  "recommendation": "specific, actionable fix"
}]

Return only the JSON array.`,
    1200
  );

  return Array.isArray(result) ? result : [];
}

async function analyzeGaps(pages, compressions, sitePurpose) {
  // Topic frequency from compressions
  const freq = {};
  for (const c of compressions) {
    for (const e of c.key_entities || []) {
      freq[e] = (freq[e] || 0) + 1;
    }
  }
  const topTopics = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([t, n]) => `${t} (${n})`)
    .join(', ');

  const pageTypes = [...new Set(pages.map(p => p.page_type))].join(', ');
  const openQs = compressions
    .flatMap(c => (c.open_questions || []).map(q => `[${c.url}] ${q}`))
    .slice(0, 10)
    .join('\n') || 'none identified';

  const result = await callClaude(
    'claude-sonnet-4-6',
    `You are identifying content gaps for a website.

Site purpose: ${sitePurpose || 'infer from context below'}
Pages analyzed: ${pages.length}
Page types present: ${pageTypes}

Topics currently covered (frequency across pages):
${topTopics || 'not determined'}

Questions raised by existing pages that go unanswered:
${openQs}

Identify genuine content gaps — missing topics, page types, or content formats this site needs but lacks. Rules:
- Ground every gap in evidence (a page raises it without resolving it, OR a site of this type clearly needs it)
- Don't invent gaps for content that may exist behind login or in PDFs
- Prioritize by importance to site purpose and likely audience demand

Return a JSON array:
[{
  "title": "gap name",
  "severity": "high|medium|low",
  "description": "what's missing and why it matters to users",
  "evidence": "why this gap exists (specific page that raises it, or expected content for this site type)",
  "recommendation": "what to create and where to place it",
  "content_type": "page|section|FAQ|comparison|case study|tutorial|etc"
}]

Return only the JSON array.`,
    1200
  );

  return Array.isArray(result) ? result : [];
}

async function synthesize(pages, ia, gaps, sitePurpose, siteUrl) {
  const highTotal = [...ia, ...gaps].filter(f => f.severity === 'high').length;

  const result = await callClaude(
    'claude-haiku-4-5-20251001',
    `Write an executive summary for a content strategy audit.

Site: ${siteUrl}
Purpose: ${sitePurpose || 'inferred from content'}
Pages analyzed: ${pages.length}

Findings:
- IA/Hierarchy: ${ia.length} findings. High-severity: ${ia.filter(f=>f.severity==='high').length}. Top: ${ia.slice(0,2).map(f=>f.title).join('; ') || 'none'}
- Content Gaps: ${gaps.length} gaps. High-priority: ${gaps.filter(f=>f.severity==='high').length}. Top: ${gaps.slice(0,2).map(f=>f.title).join('; ') || 'none'}
- Total high-severity: ${highTotal}

Return a JSON object:
{
  "executive_summary": "2 paragraphs. First: overall content health. Second: the most important pattern in the findings. Be direct, specific, professional. Not a pep talk.",
  "top_recommendations": ["5 specific, prioritized, actionable recommendations ordered by impact"],
  "quick_wins": ["3 specific changes fixable in under one hour each — must be concrete"]
}

Return only the JSON object.`,
    900
  );

  const scores = {
    ia:   scoreFindings(ia),              // (22, 10, 4) — structural foundation, most penalizing
    gaps: scoreFindings(gaps, 16, 7, 3),  // mid priority — missing content harms value delivery
  };

  const fallback = {
    executive_summary: `Audit of ${siteUrl} complete. ${ia.length + gaps.length} findings across ${pages.length} pages.`,
    top_recommendations: [...ia, ...gaps].slice(0, 5).map(f => f.recommendation || f.title),
    quick_wins: [...gaps].slice(0, 3).map(f => f.recommendation || f.title),
  };

  return {
    synthesis: result && result.executive_summary ? result : fallback,
    scores,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Analysis service not configured.' });
  }

  const { site_map, site_purpose } = req.body || {};
  if (!site_map?.pages?.length) {
    return res.status(400).json({ error: 'site_map with pages is required' });
  }

  const { pages, link_graph: linkGraph = [], root_url: siteUrl } = site_map;

  try {
    const compressions = await compressPages(pages);
    const iaMetrics = computeIAMetrics(pages, linkGraph);

    const [iaFindings, gapFindings] = await Promise.all([
      analyzeIA(pages, linkGraph, iaMetrics, site_purpose),
      analyzeGaps(pages, compressions, site_purpose),
    ]);

    const { synthesis, scores } = await synthesize(
      pages,
      iaFindings,
      gapFindings,
      site_purpose,
      siteUrl
    );

    return res.status(200).json({
      metadata: {
        url: siteUrl,
        purpose: site_purpose || null,
        pages_analyzed: pages.length,
        crawled_at: site_map.crawled_at,
        analyzed_at: new Date().toISOString(),
      },
      scores,
      executive_summary: synthesis.executive_summary,
      top_recommendations: synthesis.top_recommendations || [],
      quick_wins: synthesis.quick_wins || [],
      ia_findings: iaFindings,
      gap_findings: gapFindings,
    });
  } catch (err) {
    console.error('Analysis error:', err);
    return res.status(500).json({
      error: 'Analysis failed: ' + (err.message || 'Unknown error'),
    });
  }
}
