# content-strategy-portfolio

Personal portfolio for **Drew Johnson** — UX content strategy and AI content
architecture. Live at **[rdrewj.com](https://rdrewj.com)**.

The site pairs a static front end with a small set of serverless functions that
power two interactive, AI-driven tools.

## Structure

```
.
├── index.html              # Landing page (hero, approach, work, expertise, contact)
├── case-studies/           # Long-form case studies
│   ├── answer-widgets.html
│   ├── talent-architecture.html
│   └── ux-writing-guide.html
├── tools/                  # Interactive AI tools (front end)
│   ├── csx-audit.html      # Content/IA site audit
│   └── copy-clinic.html    # Copy critique
├── api/                    # Vercel serverless functions
│   ├── crawl.js            # Crawls a site and builds a page/link graph
│   ├── analyze.js          # Computes IA metrics + LLM analysis for the audit
│   └── critique.js         # LLM-powered copy critique
├── lib/                    # Shared server-side helpers
│   └── security.js         # SSRF-safe fetch, CORS, and rate limiting
├── Drew_Johnson-Resume.pdf
├── CNAME                   # Custom domain (rdrewj.com)
├── vercel.json             # Routing + function config
└── package.json
```

## Tools

- **CSX Audit** (`/tools/csx-audit`) — Crawls a URL, builds a link graph,
  computes information-architecture metrics (orphaned pages, depth, dead ends,
  category groupings), and layers on an AI analysis.
- **Copy Clinic** (`/tools/copy-clinic`) — Submits copy for an AI-powered
  critique.

Both tools call the serverless functions in `api/`, which use the
[Anthropic API](https://docs.anthropic.com/) for analysis and
[Upstash Redis](https://upstash.com/) for rate limiting.

## Tech stack

- Static HTML/CSS/JS (no build step for the front end)
- [Vercel](https://vercel.com/) serverless functions (`api/*.js`, ES modules)
- [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) — AI analysis
- [`@upstash/ratelimit`](https://www.npmjs.com/package/@upstash/ratelimit) +
  [`@upstash/redis`](https://www.npmjs.com/package/@upstash/redis) — rate limiting
- [`cheerio`](https://www.npmjs.com/package/cheerio) — HTML parsing for the crawler

## Local development

Install dependencies and run with the Vercel CLI so the API routes work:

```bash
npm install
vercel dev
```

The static pages can also be opened directly in a browser, but the AI tools
require the serverless functions (and the environment variables below) to run.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API access for analysis and critique |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis endpoint for rate limiting |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis auth token |
| `RATE_LIMIT_BYPASS_IP` | Optional. A single IP that bypasses rate limits (e.g. your own) |

When the Upstash variables are not set, rate limiting falls back to a per-instance
in-memory limiter rather than being disabled, so there is always a ceiling on
usage. Configure Upstash in production for limits that are shared across instances.

## Deployment

Deployed on Vercel. `vercel.json` rewrites `/tools/csx-audit` to the
corresponding HTML file and allows the `api/*` functions up to a 60-second
runtime. The production domain is configured via `CNAME`.
