import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const README_PATH = path.join(ROOT_DIR, 'README.md');

const OWNER = process.env.GITHUB_OWNER || 'PaulNasc';
const START_MARKER = '<!-- PROJECTS:START -->';
const END_MARKER = '<!-- PROJECTS:END -->';

const FALLBACK_DESCRIPTIONS = {
  'Dashboard-project':
    'Interface de dashboard web interativo desenvolvido com HTML5, CSS3 e JavaScript.',
  controle_estoque:
    'Aplicação desktop em Python integrada a banco de dados SQL para controle de estoque.',
  instagram:
    'Interface web inspirada na página inicial do Instagram para prática de HTML5 e CSS3.',
};

const CATEGORY_MAP = {
  nexus: 'Ecossistema / Desktop',
  gostate: 'QA & Automação E2E',
  controle_estoque: 'Estudos / Desktop',
};

function sanitizeCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function formatDatePtBr(isoDate) {
  if (!isoDate) return '—';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}

async function fetchOwnedPublicRepos(owner) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${owner}-profile-readme-sync`,
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const url = `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&type=owner&sort=pushed`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GitHub API error (${response.status}): ${body.slice(0, 200)}`);
  }

  const repos = await response.json();
  if (!Array.isArray(repos)) {
    throw new Error('Unexpected GitHub API payload: expected an array of repositories.');
  }

  return repos
    .filter(
      (repo) =>
        repo &&
        !repo.fork &&
        !repo.private &&
        Number(repo.size) > 0 &&
        repo.name.toLowerCase() !== owner.toLowerCase()
    )
    .sort((a, b) => new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime());
}

function buildProjectsTable(repos) {
  if (repos.length === 0) {
    return '_Nenhum repositório público encontrado no momento._';
  }

  const header = [
    '| Repositório | Categoria | Descrição | Stack | Atualizado em | Stars |',
    '| :--- | :--- | :--- | :---: | :---: | :---: |',
  ];

  const rows = repos.map((repo) => {
    const nameLink = `[**${sanitizeCell(repo.name)}**](${repo.html_url})`;
    const category = CATEGORY_MAP[repo.name] || 'Estudos / Web';
    const description = sanitizeCell(
      FALLBACK_DESCRIPTIONS[repo.name] ||
        repo.description ||
        `Repositório público desenvolvido com ${repo.language || 'tecnologias web'}.`
    );
    const language = sanitizeCell(repo.language || 'Web');
    const updated = formatDatePtBr(repo.pushed_at);
    const stars = Number(repo.stargazers_count) || 0;

    return `| ${nameLink} | ${category} | ${description} | \`${language}\` | ${updated} | ⭐ ${stars} |`;
  });

  return [...header, ...rows].join('\n');
}

async function main() {
  const isCheckOnly = process.argv.includes('--check');
  const readme = await fs.readFile(README_PATH, 'utf8');

  const startIdx = readme.indexOf(START_MARKER);
  const endIdx = readme.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(`Markers ${START_MARKER} / ${END_MARKER} not found or invalid in README.md`);
  }

  const repos = await fetchOwnedPublicRepos(OWNER);
  const tableMarkdown = buildProjectsTable(repos);

  const before = readme.slice(0, startIdx + START_MARKER.length);
  const after = readme.slice(endIdx);
  const nextReadme = `${before}\n${tableMarkdown}\n${after}`;

  if (nextReadme === readme) {
    console.log(`README.md is already up to date (${repos.length} repositories verified).`);
    return;
  }

  if (isCheckOnly) {
    console.error('README.md project catalog is out of date.');
    process.exitCode = 1;
    return;
  }

  await fs.writeFile(README_PATH, nextReadme, 'utf8');
  console.log(`Updated README.md with ${repos.length} verified public repositories.`);
}

export { sanitizeCell, formatDatePtBr, buildProjectsTable, fetchOwnedPublicRepos, main };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
