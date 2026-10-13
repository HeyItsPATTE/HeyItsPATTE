// Builds assets/stats-dark.svg and assets/stats-light.svg from the GitHub GraphQL API.
//
// Unlike public stats services this runs with the profile owner's own token, so contributions
// and languages from private repositories are counted. Only totals are rendered: no repository
// names, no commit messages.
//
// Env:
//   STATS_TOKEN    personal access token of the profile owner (classic: repo, read:user)
//   STATS_USER     GitHub login (defaults to the repository owner)
//   EXCLUDE_LANGS  comma-separated languages to leave out of the language bar
//   EXCLUDE_REPOS  comma-separated repository names to leave out of the language bar
//   STATS_FIXTURE  path to a JSON file with recorded API data (local testing, no token needed)
//   STATS_OUT      output directory (default: assets)

import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.STATS_OUT || path.join(here, "..", "..", "assets");
const USER = process.env.STATS_USER || process.env.GITHUB_REPOSITORY_OWNER || "HeyItsPATTE";
const list = (v) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const EXCLUDE_LANGS = list(process.env.EXCLUDE_LANGS ?? "ShaderLab,HLSL");
const EXCLUDE_REPOS = list(process.env.EXCLUDE_REPOS);

// ---------------------------------------------------------------------------------- data

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${process.env.STATS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${USER}-profile-stats`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`GitHub API ${res.status}: ${JSON.stringify(body.errors || body.message || body)}`);
  }
  return body.data;
}

const COLLECTION = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    createdAt
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }
  }
}`;

const REPOS = `query($login: String!, $cursor: String) {
  user(login: $login) {
    repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes { name languages(first: 25, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } } }
    }
  }
}`;

async function fetchLive() {
  if (!process.env.STATS_TOKEN) {
    throw new Error("STATS_TOKEN is not set. Add it under Settings > Secrets and variables > Actions.");
  }
  const now = new Date();
  // The API allows at most one year per query; the commit/PR/issue breakdown uses exactly that.
  const yearAgo = new Date(now);
  yearAgo.setUTCFullYear(now.getUTCFullYear() - 1);
  yearAgo.setUTCDate(yearAgo.getUTCDate() + 1);

  const lastYear = await gql(COLLECTION, { login: USER, from: yearAgo.toISOString(), to: now.toISOString() });
  const createdAt = new Date(lastYear.user.createdAt);

  // One query per calendar year since the account was created, for the all-time longest streak.
  const years = [];
  for (let y = createdAt.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Math.max(Date.UTC(y, 0, 1), createdAt.getTime()));
    const to = new Date(Math.min(Date.UTC(y, 11, 31, 23, 59, 59), now.getTime()));
    const d = await gql(COLLECTION, { login: USER, from: from.toISOString(), to: to.toISOString() });
    years.push(d.user.contributionsCollection.contributionCalendar);
  }

  const repos = [];
  let cursor = null;
  do {
    const d = await gql(REPOS, { login: USER, cursor });
    repos.push(...d.user.repositories.nodes);
    cursor = d.user.repositories.pageInfo.hasNextPage ? d.user.repositories.pageInfo.endCursor : null;
  } while (cursor);

  return { generatedAt: now.toISOString(), lastYear: lastYear.user.contributionsCollection, years, repos };
}

// ------------------------------------------------------------------------------- numbers

const days = (cal) => cal.weeks.flatMap((w) => w.contributionDays);

function summarize(raw) {
  const ly = raw.lastYear;
  const lastYearDays = days(ly.contributionCalendar);

  const byDate = new Map();
  for (const cal of raw.years) for (const d of days(cal)) byDate.set(d.date, d.contributionCount);
  for (const d of lastYearDays) byDate.set(d.date, d.contributionCount);
  const all = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Headline total over the same window as the profile's contribution graph:
  // one year back, starting on that week's Sunday (a few days more than 365).
  const end = new Date(raw.generatedAt);
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), end.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const startKey = start.toISOString().slice(0, 10);
  const total = all.reduce((s, [d, n]) => (d >= startKey ? s + n : s), 0);

  let longest = 0, run = 0;
  for (const [, n] of all) { run = n > 0 ? run + 1 : 0; longest = Math.max(longest, run); }

  // Current streak: a day without contributions yet today does not break it.
  let current = 0;
  let i = all.length - 1;
  if (i >= 0 && all[i][1] === 0) i--;
  while (i >= 0 && all[i][1] > 0) { current++; i--; }

  // Contributions per month for the last 12 months, the current month last.
  const months = [];
  for (let k = 11; k >= 0; k--) {
    const m = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - k, 1));
    months.push({ key: m.toISOString().slice(0, 7), label: m.toLocaleString("en-US", { month: "short", timeZone: "UTC" }), count: 0 });
  }
  const monthIdx = new Map(months.map((m, j) => [m.key, j]));
  for (const d of lastYearDays) {
    const j = monthIdx.get(d.date.slice(0, 7));
    if (j !== undefined) months[j].count += d.contributionCount;
  }

  const langs = new Map();
  for (const repo of raw.repos) {
    if (EXCLUDE_REPOS.includes(repo.name.toLowerCase())) continue;
    for (const e of repo.languages.edges) {
      if (EXCLUDE_LANGS.includes(e.node.name.toLowerCase())) continue;
      const cur = langs.get(e.node.name) || { name: e.node.name, color: e.node.color || "#8b949e", size: 0 };
      cur.size += e.size;
      langs.set(e.node.name, cur);
    }
  }
  const sorted = [...langs.values()].sort((a, b) => b.size - a.size);
  const totalSize = sorted.reduce((s, l) => s + l.size, 0) || 1;
  // Up to six languages with at least 1 % get their own entry; everything else becomes "Other".
  const shown = sorted.filter((l) => l.size / totalSize >= 0.01).slice(0, 6);
  const rest = totalSize - shown.reduce((s, l) => s + l.size, 0);
  let languages = [...shown];
  if (rest / totalSize >= 0.005) languages.push({ name: "Other", color: "#8b949e", size: rest });
  const listed = languages.reduce((s, l) => s + l.size, 0) || 1;
  languages = languages.map((l) => ({ ...l, pct: (100 * l.size) / listed }));

  return {
    total,
    commits: ly.totalCommitContributions,
    prs: ly.totalPullRequestContributions,
    issues: ly.totalIssueContributions,
    reviews: ly.totalPullRequestReviewContributions,
    current, longest, months, languages,
    updated: end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Berlin" }),
  };
}

// ------------------------------------------------------------------------------- drawing

const fonts = JSON.parse(fs.readFileSync(path.join(here, "fonts.json"), "utf8"));
const THEMES = {
  dark: { fg: "#F0F6FC", muted: "#9198A1", bar: "#3D444D", red: "#F0283C" },
  light: { fg: "#1F2328", muted: "#59636E", bar: "#D1D9E0", red: "#D70A24" },
};
const W = 760;
const MONO_W = 0.6; // JetBrains Mono advance per em
const fmt = (n) => n.toLocaleString("en-US");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

function render(s, theme) {
  const c = THEMES[theme];
  const parts = [];

  // Headline number and streaks.
  parts.push(`<text class="big" x="0" y="92">${fmt(s.total)}</text>`);
  parts.push(`<text class="label" x="2" y="122">contributions in the last 12 months</text>`);
  const streak = (x, n, label) =>
    `<text class="mid" x="${x}" y="78" text-anchor="end">${fmt(n)}</text>` +
    `<text class="label" x="${x}" y="104" text-anchor="end">${label}</text>`;
  parts.push(streak(W - 170, s.current, "current streak"));
  parts.push(streak(W, s.longest, "longest streak"));

  // Contributions per month.
  const top = 152, h = 78, gap = 8;
  const bw = (W - gap * 11) / 12;
  const max = Math.max(1, ...s.months.map((m) => m.count));
  s.months.forEach((m, j) => {
    const x = j * (bw + gap);
    const bh = m.count ? Math.max(3, (m.count / max) * h) : 1.5;
    const fill = j === 11 ? c.red : c.bar;
    parts.push(`<rect x="${x.toFixed(1)}" y="${(top + h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${fill}"><title>${m.label}: ${fmt(m.count)}</title></rect>`);
    parts.push(`<text class="tiny" x="${(x + bw / 2).toFixed(1)}" y="${top + h + 20}" text-anchor="middle">${m.label}</text>`);
  });

  // What the total is made of.
  const items = [plural(s.commits, "commit", "commits"), plural(s.prs, "pull request", "pull requests"),
    plural(s.issues, "issue", "issues"), plural(s.reviews, "review", "reviews")];
  let x = 0;
  const row = items.map((t) => { const el = `<text class="stat" x="${x}" y="296">${esc(t)}</text>`; x += t.length * 15 * MONO_W + 30; return el; });
  parts.push(...row);

  // Languages across all owned repositories.
  let lx = 0;
  const barY = 320;
  parts.push(`<clipPath id="lb"><rect x="0" y="${barY}" width="${W}" height="10" rx="5"/></clipPath><g clip-path="url(#lb)">`);
  s.languages.forEach((l, j) => {
    const w = j === s.languages.length - 1 ? W - lx : (l.pct / 100) * W;
    parts.push(`<rect x="${lx.toFixed(1)}" y="${barY}" width="${Math.max(0, w).toFixed(1)}" height="10" fill="${esc(l.color)}"/>`);
    lx += w;
  });
  parts.push(`</g>`);
  let gx = 0, gy = barY + 34;
  for (const l of s.languages) {
    const t = `${l.name} ${l.pct.toFixed(1)}%`;
    const w = 14 + t.length * 13 * MONO_W + 22;
    if (gx + w > W + 22) { gx = 0; gy += 24; }
    parts.push(`<circle cx="${gx + 5}" cy="${gy - 4.5}" r="5" fill="${esc(l.color)}"/><text class="small" x="${gx + 16}" y="${gy}">${esc(t)}</text>`);
    gx += w;
  }

  const H = gy + 34;
  parts.push(`<text class="tiny" x="0" y="${H - 4}">Updated ${esc(s.updated)}. Includes private repositories.</text>`);

  const summary = `${fmt(s.total)} contributions in the last 12 months, current streak ${s.current} days, longest streak ${s.longest} days. Top languages: ${s.languages.map((l) => `${l.name} ${l.pct.toFixed(0)}%`).join(", ")}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(summary)}">
<title>${esc(summary)}</title>
<style>
@font-face{font-family:"KN";font-weight:800;src:url(data:font/woff2;base64,${fonts.display}) format("woff2")}
@font-face{font-family:"KM";src:url(data:font/woff2;base64,${fonts.mono}) format("woff2")}
.big,.mid{font-family:"KN","Saira Condensed","Arial Narrow",sans-serif;font-weight:800;fill:${c.fg}}
.big{font-size:112px;letter-spacing:-1px}.mid{font-size:60px}
.label,.stat,.small,.tiny{font-family:"KM","JetBrains Mono",ui-monospace,monospace}
.label{font-size:15px;fill:${c.muted}}.stat{font-size:15px;fill:${c.fg}}.small{font-size:13px;fill:${c.muted}}.tiny{font-size:12px;fill:${c.muted}}
</style>
${parts.join("\n")}
</svg>
`;
}

// ---------------------------------------------------------------------------------- main

if (!process.env.STATS_FIXTURE && !process.env.STATS_TOKEN) {
  console.log("::warning::STATS_TOKEN is not set, skipping. Add it under Settings > Secrets and variables > Actions.");
  process.exit(0);
}
const raw = process.env.STATS_FIXTURE
  ? JSON.parse(fs.readFileSync(process.env.STATS_FIXTURE, "utf8"))
  : await fetchLive();
const stats = summarize(raw);
fs.mkdirSync(OUT, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  fs.writeFileSync(path.join(OUT, `stats-${theme}.svg`), render(stats, theme));
}
const { months, languages, ...headline } = stats;
console.log(JSON.stringify({ ...headline, months: months.map((m) => m.count), languages: languages.map((l) => `${l.name} ${l.pct.toFixed(1)}%`) }));
