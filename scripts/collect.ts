/**
 * 기술 트렌드 데이터 수집 스크립트
 *
 * 실행: npm run collect
 *
 * 데이터 소스:
 * - GitHub API  : 레포 스타 수   → 관심도    (가중치 40%)
 * - npm API     : 주간 다운로드  → 실사용량  (가중치 35%, JS 생태계 한정)
 * - Stack Overflow API : 태그 질문 수 → 학습 수요 (가중치 25%)
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const DATA_PATH     = join(__dirname, "../data/trends.json");
const DOMAINS_PATH  = join(__dirname, "../data/domains.json");

// ─────────────────────────────────────────
// 기술 목록
// ─────────────────────────────────────────

interface Tech {
  name: string;
  github?: string;
  npm?: string;
  so?: string;
}

interface DomainConfig {
  label: string;
  techs: Tech[];
}

function loadDomains(): Record<string, DomainConfig> {
  if (!existsSync(DOMAINS_PATH)) {
    throw new Error("data/domains.json이 없습니다. 레포를 올바르게 클론했는지 확인하세요.");
  }
  return JSON.parse(readFileSync(DOMAINS_PATH, "utf-8")) as Record<string, DomainConfig>;
}

// ─────────────────────────────────────────
// API fetch
// ─────────────────────────────────────────

async function getGitHubStars(repo: string): Promise<number | null> {
  const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!res.ok) return null;

  const data = await res.json() as { stargazers_count: number };
  return data.stargazers_count;
}

async function getNpmDownloads(pkg: string): Promise<number | null> {
  const encoded = pkg.startsWith("@") ? pkg.replace("/", "%2F") : pkg;
  const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encoded}`);
  if (!res.ok) return null;

  const data = await res.json() as { downloads?: number };
  return data.downloads ?? null;
}

async function getSOCount(tag: string): Promise<number | null> {
  const res = await fetch(
    `https://api.stackexchange.com/2.3/tags/${encodeURIComponent(tag)}/info?site=stackoverflow`
  );
  if (!res.ok) return null;

  const data = await res.json() as { items?: Array<{ count: number }> };
  return data.items?.[0]?.count ?? null;
}

// ─────────────────────────────────────────
// 점수 계산
// ─────────────────────────────────────────

interface Metrics {
  githubStars: number | null;
  npmDownloads: number | null;
  soQuestions: number | null;
}

function calcScore(metrics: Metrics, max: Metrics): number {
  const normalize = (v: number | null, m: number | null) =>
    v !== null && m ? Math.round((v / m) * 100) : null;

  const scores = [
    { value: normalize(metrics.githubStars,  max.githubStars),  weight: 0.4  },
    { value: normalize(metrics.npmDownloads, max.npmDownloads), weight: 0.35 },
    { value: normalize(metrics.soQuestions,  max.soQuestions),  weight: 0.25 },
  ].filter((s) => s.value !== null) as { value: number; weight: number }[];

  if (!scores.length) return 0;

  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  return Math.round(scores.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight);
}

// ─────────────────────────────────────────
// 이전 순위 비교
// ─────────────────────────────────────────

function getPreviousRanks(domain: string): Record<string, number> {
  if (!existsSync(DATA_PATH)) return {};

  try {
    const prev = JSON.parse(readFileSync(DATA_PATH, "utf-8")) as TrendsOutput;
    const rankings = prev.domains[domain]?.rankings ?? [];
    return Object.fromEntries(rankings.map((r) => [r.name, r.rank]));
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────
// 출력 타입
// ─────────────────────────────────────────

interface Ranking {
  rank: number;
  rankChange: number | null; // 양수: 상승, 음수: 하락, null: 신규
  name: string;
  score: number;
  metrics: Metrics;
}

interface DomainResult {
  label: string;
  updatedAt: string;
  rankings: Ranking[];
}

interface TrendsOutput {
  collectedAt: string;
  domains: Record<string, DomainResult>;
}

// ─────────────────────────────────────────
// 도메인별 수집
// ─────────────────────────────────────────

async function collectDomain(key: string, config: DomainConfig): Promise<DomainResult> {
  const { label, techs } = config;
  console.log(`\n[${label}] (${techs.length}개)`);

  const prevRanks = getPreviousRanks(key);
  const raw: { name: string; metrics: Metrics }[] = [];

  for (const tech of techs) {
    const soTag = tech.so ?? tech.name.toLowerCase();

    const [githubStars, npmDownloads, soQuestions] = await Promise.all([
      tech.github ? getGitHubStars(tech.github) : null,
      tech.npm    ? getNpmDownloads(tech.npm)    : null,
      getSOCount(soTag),
    ]);

    const metrics: Metrics = { githubStars, npmDownloads, soQuestions };

    console.log(
      `  ${tech.name.padEnd(18)} ★${String(githubStars ?? "-").padStart(8)} | npm ${String(npmDownloads ?? "-").padStart(12)}/주 | SO ${String(soQuestions ?? "-").padStart(10)}건`
    );

    raw.push({ name: tech.name, metrics });
    await new Promise((r) => setTimeout(r, 250));
  }

  // 정규화용 최대값
  const max: Metrics = {
    githubStars:  Math.max(...raw.map((r) => r.metrics.githubStars  ?? 0)),
    npmDownloads: Math.max(...raw.map((r) => r.metrics.npmDownloads ?? 0)),
    soQuestions:  Math.max(...raw.map((r) => r.metrics.soQuestions  ?? 0)),
  };

  const sorted = raw
    .map((r) => ({ ...r, score: calcScore(r.metrics, max) }))
    .sort((a, b) => b.score - a.score);

  const rankings: Ranking[] = sorted.map((r, i) => {
    const currentRank = i + 1;
    const prev = prevRanks[r.name];
    return {
      rank: currentRank,
      rankChange: prev != null ? prev - currentRank : null,
      name: r.name,
      score: r.score,
      metrics: r.metrics,
    };
  });

  return { label, updatedAt: new Date().toISOString(), rankings };
}

// ─────────────────────────────────────────
// 메인
// ─────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("기술 트렌드 데이터 수집");
  console.log(`GitHub 인증: ${GITHUB_TOKEN ? "있음 (5000req/h)" : "없음 (60req/h)"}`);
  console.log("=".repeat(60));

  const DOMAINS = loadDomains();
  const totalTechs = Object.values(DOMAINS).reduce((s, d) => s + d.techs.length, 0);
  console.log(`추적 기술: ${totalTechs}개 (${Object.keys(DOMAINS).length}개 도메인)\n`);

  const domains: Record<string, DomainResult> = {};

  for (const [key, config] of Object.entries(DOMAINS)) {
    domains[key] = await collectDomain(key, config);
  }

  const output: TrendsOutput = {
    collectedAt: new Date().toISOString(),
    domains,
  };

  writeFileSync(DATA_PATH, JSON.stringify(output, null, 2), "utf-8");

  console.log("\n" + "=".repeat(60));
  console.log("✅ 저장 완료: data/trends.json");
  console.log("\n도메인별 TOP 3:");
  for (const [, result] of Object.entries(domains)) {
    const top3 = result.rankings.slice(0, 3).map((r) => `${r.name}(${r.score})`).join(", ");
    console.log(`  ${result.label}: ${top3}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
