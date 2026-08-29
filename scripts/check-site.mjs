import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
const root = process.cwd();
const failures = [];
async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    if (['.git', 'node_modules'].includes(name)) continue;
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isDirectory()) out.push(...await walk(path)); else out.push(path);
  }
  return out;
}
const htmlFiles = (await walk(root)).filter(path => path.endsWith('.html'));
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const label = relative(root, file);
  if (!/<meta\s+name=["']robots["']\s+content=["']noindex, nofollow["']/.test(html)) failures.push(`${label}: missing intentional noindex directive`);
  if (!/<meta\s+name=["']description["']/.test(html)) failures.push(`${label}: missing meta description`);
  if ((html.match(/<h1\b/g) || []).length !== 1) failures.push(`${label}: expected exactly one h1`);
  for (const match of html.matchAll(/href=["']([^"'#]+)(?:#[^"']*)?["']/g)) {
    const href = match[1];
    if (/^(https?:|mailto:|tel:)/.test(href)) continue;
    const clean = href.split('?')[0];
    if (!clean || clean === '/') continue;
    const target = clean.startsWith('/') ? resolve(root, clean.slice(1)) : resolve(dirname(file), clean);
    const candidates = [target, `${target}.html`, join(target, 'index.html')];
    let found = false;
    for (const candidate of candidates) {
      try { if ((await stat(normalize(candidate))).isFile()) { found = true; break; } } catch {}
    }
    if (!found) failures.push(`${label}: unresolved link ${href}`);
  }
}
for (const path of ['api/analyze.js', 'api/crawl.js', 'api/critique.js']) {
  const source = await readFile(join(root, path), 'utf8');
  if (!source.includes("ENABLE_RETIRED_TOOLS !== 'true'")) failures.push(`${path}: retired-service guard missing`);
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`Validated ${htmlFiles.length} HTML pages and retired API guards.`);
