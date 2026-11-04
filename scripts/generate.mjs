#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const USER = "syntony666";
const TOKEN = process.env.GH_PAT;
if (!TOKEN) {
  console.error("error: GH_PAT environment variable is required");
  process.exit(1);
}

const STATS_QUERY = `
  query ($login: String!) {
    user(login: $login) {
      contributionsCollection {
        totalCommitContributions
        restrictedContributionsCount
      }
      pullRequests(first: 1) {
        totalCount
      }
      openIssues: issues(states: OPEN) {
        totalCount
      }
      closedIssues: issues(states: CLOSED) {
        totalCount
      }
      repositoriesContributedTo(
        first: 1
        contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
      ) {
        totalCount
      }
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
        nodes {
          stargazerCount
        }
      }
      followers {
        totalCount
      }
    }
  }
`;

const LANGS_QUERY = `
  query ($login: String!) {
    user(login: $login) {
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
        nodes {
          name
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

async function graphql(query) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${USER}-stats`,
    },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(
      `GraphQL failed (${res.status}): ${JSON.stringify(json.errors ?? json)}`
    );
  }
  return json.data.user;
}

const [stats, langData] = await Promise.all([
  graphql(STATS_QUERY),
  graphql(LANGS_QUERY),
]);

const totalStars = stats.repositories.nodes.reduce(
  (sum, r) => sum + r.stargazerCount,
  0
);
const totalCommits =
  stats.contributionsCollection.totalCommitContributions +
  (stats.contributionsCollection.restrictedContributionsCount ?? 0);
const totalPRs = stats.pullRequests.totalCount;
const totalIssues =
  stats.openIssues.totalCount + stats.closedIssues.totalCount;
const contributedTo = stats.repositoriesContributedTo.totalCount;
const followers = stats.followers.totalCount;

// Rank: simplified port of github-readme-stats calculateRank.
// Weighted exponential/log-normal CDF against community medians -> percentile.
const expCdf = (x) => 1 - 2 ** -x;
const logCdf = (x) => x / (1 + x);
const rankScore =
  1 -
  (2 * expCdf(totalCommits / 250) +
    3 * expCdf(totalPRs / 50) +
    1 * expCdf(totalIssues / 25) +
    4 * logCdf(totalStars / 50) +
    1 * logCdf(followers / 10)) /
    11;
const percentile = rankScore * 100;
const RANK_LEVELS = [
  [1, "S"],
  [12.5, "A+"],
  [25, "A"],
  [37.5, "A-"],
  [50, "B+"],
  [62.5, "B"],
  [75, "B-"],
  [87.5, "C+"],
  [100, "C"],
];
const rank = RANK_LEVELS.find(([t]) => percentile <= t)?.[1] ?? "C";
const rankColor = { S: "#a08c5b", A: "#6f8ba4", B: "#7d9468" }[rank[0]] ?? "#8a9199";

const envSet = (name, fallback = "") =>
  new Set(
    (process.env[name] ?? fallback)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
const EXCLUDED_LANGS = envSet("EXCLUDE_LANGS", "Stylus,SCSS");
const EXCLUDED_REPOS = envSet("EXCLUDE_REPOS");
const langTotals = new Map();
for (const repo of langData.repositories.nodes) {
  if (EXCLUDED_REPOS.has(repo.name.toLowerCase())) continue;
  for (const edge of repo.languages.edges) {
    const name = edge.node.name;
    if (EXCLUDED_LANGS.has(name.toLowerCase())) continue;
    const cur = langTotals.get(name) ?? { size: 0, color: "#8a9199" };
    cur.size += edge.size;
    if (edge.node.color) cur.color = edge.node.color;
    langTotals.set(name, cur);
  }
}
const langTotalSize = [...langTotals.values()].reduce((s, l) => s + l.size, 0);
const langs = [...langTotals.entries()]
  .map(([name, v]) => ({ name, ...v, pct: (v.size / langTotalSize) * 100 }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 6);

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const kfmt = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`;

const rows = [
  ["Stars", totalStars],
  ["Total Commits (incl. private)", totalCommits],
  ["Total PRs", totalPRs],
  ["Total Issues", totalIssues],
  ["Contributed to", contributedTo],
];

const statRows = rows
  .map(
    ([label, value], i) => `
    <text x="30" y="${66 + i * 25}" class="t">${label}</text>
    <text x="270" y="${66 + i * 25}" class="b" text-anchor="end">${kfmt(value)}</text>`
  )
  .join("");

const LANG_ROW_Y = 64;
const LANG_ROW_STEP = 23;
const BAR_X = 505;
const BAR_W = 130;
const langRows = langs
  .map(
    (l, i) => `
    <text x="400" y="${LANG_ROW_Y + i * LANG_ROW_STEP}" class="t">${esc(trunc(l.name, 12))}</text>
    <rect x="${BAR_X}" y="${LANG_ROW_Y - 7 + i * LANG_ROW_STEP}" width="${BAR_W}" height="8" rx="4" class="track"/>
    <rect x="${BAR_X}" y="${LANG_ROW_Y - 7 + i * LANG_ROW_STEP}" width="${((l.pct / 100) * BAR_W).toFixed(1)}" height="8" rx="4" fill="${l.color}"/>
    <text x="688" y="${LANG_ROW_Y + i * LANG_ROW_STEP}" class="t" text-anchor="end">${l.pct.toFixed(1)}%</text>`
  )
  .join("");

const PALETTES = {
  light: {
    text: "#3d444d",
    strong: "#1f2328",
    accent: "#3f7a70",
    line: "#d1d9e0",
    track: "#e8edf2",
  },
  dark: {
    text: "#9198a1",
    strong: "#f0f6fc",
    accent: "#7db0a4",
    line: "#3d444d",
    track: "#1c2128",
  },
};

const renderSvg = (p) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="200" viewBox="0 0 720 200">
  <title>${USER}'s GitHub stats</title>
  <style>
    text { font-family: ui-sans-serif, -apple-system, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
    .t { fill: ${p.text}; font-size: 12.5px; }
    .b { fill: ${p.strong}; font-size: 12.5px; font-weight: 600; }
    .h { fill: ${p.strong}; font-size: 14px; font-weight: 600; }
    .accent { fill: ${p.accent}; }
    .line { stroke: ${p.line}; }
    .track { fill: ${p.track}; }
  </style>
  <rect x="0.5" y="0.5" width="719" height="199" rx="6" fill="none" class="line"/>
  <line x1="375" y1="18" x2="375" y2="182" class="line"/>

  <text x="30" y="34" class="h accent">${USER}'s GitHub Stats</text>
  ${statRows}

  <circle cx="322" cy="103" r="30" fill="none" stroke="${rankColor}" stroke-width="3"/>
  <text x="322" y="108" text-anchor="middle" font-size="14" font-weight="600" fill="${rankColor}">${rank}</text>
  <text x="322" y="160" text-anchor="middle" class="t" font-size="10">top ${percentile.toFixed(1)}%</text>

  <text x="400" y="34" class="h">Top Languages</text>
  ${langRows}
</svg>
`;

const outDir = fileURLToPath(new URL("../stats/", import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const [name, palette] of Object.entries(PALETTES)) {
  writeFileSync(`${outDir}stats-${name}.svg`, renderSvg(palette));
}
console.log(
  `wrote ${Object.keys(PALETTES)
    .map((n) => `${outDir}stats-${n}.svg`)
    .join(", ")}`,
  JSON.stringify({
    stars: totalStars,
    commits: totalCommits,
    prs: totalPRs,
    issues: totalIssues,
    contributedTo,
    followers,
    rank: `${rank} (${percentile.toFixed(1)}%)`,
    langs: langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`),
  })
);
