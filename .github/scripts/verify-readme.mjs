import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const README_PATH = path.join(ROOT_DIR, 'README.md');
const WORKFLOWS_DIR = path.join(ROOT_DIR, '.github', 'workflows');
const OWNER = process.env.GITHUB_OWNER || 'PaulNasc';

const errors = [];
const warnings = [];

function assert(condition, message) {
  if (!condition) errors.push(message);
}

function extractUrls(markdown) {
  const urls = new Set();
  const attrRegex = /(?:href|src|srcset)=["']([^"']+)["']/g;
  const mdLinkRegex = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;

  for (const match of markdown.matchAll(attrRegex)) {
    urls.add(match[1]);
  }
  for (const match of markdown.matchAll(mdLinkRegex)) {
    urls.add(match[1]);
  }
  return [...urls];
}

function checkBalancedTags(markdown) {
  const tags = ['div', 'p', 'picture', 'a', 'sub'];
  for (const tag of tags) {
    const opens = (markdown.match(new RegExp(`<${tag}(?:\\s|>)`, 'gi')) || []).length;
    const closes = (markdown.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
    assert(opens === closes, `Unbalanced <${tag}> tags: ${opens} opening vs ${closes} closing`);
  }

  // Ensure every <picture> supports both dark and light color schemes + fallback <img>
  const pictures = [...markdown.matchAll(/<picture>([\s\S]*?)<\/picture>/gi)];
  assert(pictures.length >= 6, `Expected >= 6 <picture> blocks for theme adaptability, found ${pictures.length}`);
  pictures.forEach((m, idx) => {
    const inner = m[1];
    assert(
      inner.includes('(prefers-color-scheme: dark)'),
      `<picture> #${idx + 1} missing dark color-scheme <source>`
    );
    assert(
      inner.includes('(prefers-color-scheme: light)'),
      `<picture> #${idx + 1} missing light color-scheme <source>`
    );
    assert(/<img\s/i.test(inner), `<picture> #${idx + 1} missing fallback <img>`);
  });
}

function validateWorkflowYaml(fileName, content) {
  const lines = content.split(/\r?\n/);
  assert(!content.includes('\t'), `${fileName}: YAML must not contain tab characters`);
  assert(/^name:\s+.+/m.test(content), `${fileName}: missing top-level 'name:'`);
  assert(/^on:\s*$/m.test(content), `${fileName}: missing top-level 'on:'`);
  assert(/^jobs:\s*$/m.test(content), `${fileName}: missing top-level 'jobs:'`);
  assert(/^\s+runs-on:\s+.+/m.test(content), `${fileName}: missing 'runs-on:'`);
  assert(/^\s+steps:\s*$/m.test(content), `${fileName}: missing 'steps:'`);

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const leadingSpaces = line.match(/^ */)[0].length;
    if (leadingSpaces % 2 !== 0 && !trimmed.startsWith('-')) {
      // Allow multiline block scalar content (e.g., run: | or outputs: |)
      // Only flag non-indented odd-space keys
      if (/^[a-zA-Z0-9_-]+:\s*/.test(trimmed)) {
        errors.push(`${fileName}:${idx + 1}: unexpected odd indentation (${leadingSpaces} spaces) on key`);
      }
    }
  });
}

async function verifyUrls(urls) {
  const results = await Promise.all(
    urls.map(async (url) => {
      if (url.startsWith('mailto:')) {
        const valid = /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url);
        return { url, ok: valid, status: valid ? 'mailto-ok' : 'mailto-invalid' };
      }

      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      };

      try {
        const res = await fetch(url, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        const contentType = res.headers.get('content-type') || '';
        const body = await res.text();

        const isSvgUrl =
          contentType.includes('image/svg+xml') ||
          url.includes('demolab.com') ||
          url.includes('capsule-render.vercel.app') ||
          url.includes('github-readme-stats.vercel.app') ||
          url.includes('github-readme-activity-graph.vercel.app') ||
          url.includes('shields.io') ||
          url.includes('komarev.com') ||
          url.endsWith('.svg');

        // LinkedIn commonly returns HTTP 999 to automated non-browser clients
        if (url.includes('linkedin.com') && res.status === 999) {
          warnings.push(`LinkedIn returned bot-challenge status 999 for ${url} (normal for automated HTTP clients).`);
          return { url, ok: true, status: 999, note: 'LinkedIn bot challenge' };
        }

        if (!res.ok) {
          return { url, ok: false, status: res.status, reason: `HTTP ${res.status}` };
        }

        if (isSvgUrl) {
          if (!contentType.includes('svg')) {
            return { url, ok: false, status: res.status, reason: `Expected SVG content-type, got ${contentType}` };
          }
          if (!body.includes('<svg')) {
            return { url, ok: false, status: res.status, reason: 'Payload missing <svg tag' };
          }
          const badPatterns = [
            /Something went wrong/i,
            /Rate limit/i,
            /An error occurred/i,
            /User not found/i,
            /Repository not found/i,
            /Repo not found/i,
            /Could not fetch/i,
            /404 Not Found/i,
          ];
          const hit = badPatterns.find((re) => re.test(body));
          if (hit) {
            return { url, ok: false, status: res.status, reason: `SVG contains error text matching ${hit}` };
          }
        }

        return { url, ok: true, status: res.status, contentType };
      } catch (err) {
        return { url, ok: false, status: 'FETCH_ERROR', reason: err.message };
      }
    })
  );

  for (const r of results) {
    if (!r.ok) {
      errors.push(`URL check failed [${r.status}] ${r.url}: ${r.reason}`);
    }
  }
  return results;
}

async function verifyReposAgainstGitHub(markdown) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${OWNER}-readme-verify`,
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(`https://api.github.com/users/${OWNER}/repos?per_page=100&type=owner`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    errors.push(`Failed to fetch GitHub API repos: HTTP ${res.status} ${body.slice(0, 160)}`);
    return [];
  }

  const repos = await res.json();
  if (!Array.isArray(repos)) {
    errors.push('Unexpected GitHub API payload: expected an array of repositories.');
    return [];
  }

  const ownedPublicNames = new Set(
    repos.filter((r) => r && !r.fork && !r.private).map((r) => r.name)
  );

  const repoRefs = [...markdown.matchAll(/https:\/\/github\.com\/PaulNasc\/([A-Za-z0-9_.-]+)/g)].map(
    (m) => m[1]
  );
  const uniqueRefs = [...new Set(repoRefs)];
  assert(uniqueRefs.length > 0, 'No PaulNasc repository links found in README.md');

  for (const repoName of uniqueRefs) {
    assert(
      ownedPublicNames.has(repoName),
      `Referenced repository PaulNasc/${repoName} is NOT a verified public own repo of ${OWNER}`
    );
  }
  return uniqueRefs;
}

function checkNoDuplicateSections(markdown) {
  const h2Headings = [...markdown.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim().toLowerCase());
  const seen = new Set();
  for (const h of h2Headings) {
    assert(!seen.has(h), `Duplicate section heading detected: "## ${h}"`);
    seen.add(h);
  }
}

async function main() {
  const readme = await fs.readFile(README_PATH, 'utf8');

  // 1. Required pt-BR content & anti-placeholder checks
  assert(/QA na HYBEX/i.test(readme), 'Missing current role "QA na HYBEX"');
  assert(/Nexus TCMS/i.test(readme), 'Missing Nexus TCMS details');
  assert(/Nexus HUB/i.test(readme), 'Missing Nexus HUB details');
  assert(/Nexus Workspace/i.test(readme), 'Missing Nexus Workspace details');
  assert(/https:\/\/nexus-tcms-site\.vercel\.app/i.test(readme), 'Missing Nexus TCMS landing page URL');
  assert(/Tauri/i.test(readme) && /Electron/i.test(readme), 'Missing NEXUS desktop stack details (Tauri/Electron)');
  assert(/Supabase/i.test(readme) && /Cloudflare R2/i.test(readme), 'Missing NEXUS cloud architecture details');
  assert(/Guarulhos/i.test(readme), 'Missing location Guarulhos');
  assert(/Análise e Desenvolvimento de Sistemas/i.test(readme), 'Missing degree');
  assert(
    readme.includes('<!-- PROJECTS:START -->') && readme.includes('<!-- PROJECTS:END -->'),
    'Missing PROJECTS markers'
  );
  assert(!/TODO|TBD|Lorem ipsum|example\.com/i.test(readme), 'Placeholder text detected in README.md');

  // 2. HTML/Picture balance & duplicate section check
  checkBalancedTags(readme);
  checkNoDuplicateSections(readme);

  // 3. Verify workflow YAML files
  const wfFiles = await fs.readdir(WORKFLOWS_DIR);
  for (const f of wfFiles) {
    if (f.endsWith('.yml') || f.endsWith('.yaml')) {
      const wfContent = await fs.readFile(path.join(WORKFLOWS_DIR, f), 'utf8');
      validateWorkflowYaml(f, wfContent);
    }
  }

  // 4. Verify repos against GitHub API
  const verifiedRepos = await verifyReposAgainstGitHub(readme);

  // 5. Verify all URLs
  const urls = extractUrls(readme);
  const urlResults = await verifyUrls(urls);

  console.log(`Verified ${verifiedRepos.length} repositories: ${verifiedRepos.join(', ')}`);
  console.log(`Checked ${urlResults.length} unique URLs in README.md.`);
  if (warnings.length > 0) {
    console.log('Warnings:');
    warnings.forEach((w) => console.log(`  - ${w}`));
  }

  if (errors.length > 0) {
    console.error('Verification FAILED:');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  console.log('All README.md verification checks PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
