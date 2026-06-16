import Anthropic from '@anthropic-ai/sdk';
import { applyCors, makeRateLimiter, getClientIp, isBypassIp } from '../lib/security.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ratelimiter = makeRateLimiter({
  requests: 10,
  window: '1 d',
  windowMs: 24 * 60 * 60 * 1000,
  prefix: 'copy-clinic',
});

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Analysis service not configured.' });
  }

  // Rate limiting
  const ip = getClientIp(req);
  if (!isBypassIp(ip)) {
    const ok = await ratelimiter.check(ip);
    if (!ok) {
      return res.status(429).json({
        error: 'You have run 10 analyses today. The limit resets after 24 hours.',
      });
    }
  }

  const { copy, element_type, context } = req.body || {};

  if (!copy || typeof copy !== 'string' || copy.trim().length === 0) {
    return res.status(400).json({ error: 'Copy text is required.' });
  }

  if (copy.trim().length > 1500) {
    return res.status(400).json({ error: 'Copy must be under 1,500 characters.' });
  }

  try {
    const typeClause = element_type ? `\nElement type: ${element_type}` : '';
    const contextClause = context && context.trim() ? `\nContext: ${context.trim()}` : '';

    const prompt = `You are Drew Johnson, a Senior Manager of UX Content Strategy. You specialize in content systems, voice and tone, and information architecture for enterprise products.

Analyze this piece of UX copy through a content strategy lens.

Copy: "${copy.trim()}"${typeClause}${contextClause}

Return a JSON object with exactly these four keys:
{
  "strengths": ["2-3 items. What this copy does well. Specific — reference the actual words or phrases. If it's genuinely weak across the board, include one item noting anything that's salvageable."],
  "improvements": ["2-3 items. Direct, honest problems. Reference actual words. Don't hedge."],
  "rewrite": "A single rewritten version that addresses the key improvements. Match the element type and register. Don't over-engineer it — keep it human.",
  "lens": "One sentence. The single most important content strategy insight this copy reveals, positive or negative. Specific to these words, not generic advice."
}

Rules:
- Be direct. No filler, no hedging.
- If the copy is already strong, say so explicitly and keep improvements minimal.
- The rewrite should feel like a real upgrade, not just rearranged words.
- Each array must contain strings only.

Return only the JSON object.`;

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 900,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = resp.content[0]?.text || '{}';
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return res.status(500).json({ error: 'Analysis returned an unexpected format. Please try again.' });
    }

    if (!result.strengths || !result.improvements || !result.rewrite || !result.lens) {
      return res.status(500).json({ error: 'Analysis returned incomplete results. Please try again.' });
    }

    return res.status(200).json({
      strengths: Array.isArray(result.strengths) ? result.strengths : [result.strengths],
      improvements: Array.isArray(result.improvements) ? result.improvements : [result.improvements],
      rewrite: String(result.rewrite),
      lens: String(result.lens),
    });
  } catch (err) {
    console.error('Critique error:', err);
    return res.status(500).json({
      error: 'Analysis failed: ' + (err.message || 'Unknown error'),
    });
  }
}
