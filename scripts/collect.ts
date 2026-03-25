/**
 * 기술 트렌드 데이터 수집 스크립트
 *
 * 실행: npm run collect
 *
 * 데이터 소스:
 * - GitHub API      : 레포 스타 수        → 관심도        (가중치 40%)
 * - npm API         : 주간 다운로드        → JS 실사용량
 * - PyPI API        : 주간 다운로드        → Python 실사용량
 * - crates.io API   : 90일 다운로드        → Rust 실사용량
 * - Docker Hub API  : 누적 풀 수           → 컨테이너 사용량
 *   ↑ 위 4개 소스 중 우선순위(npm>pypi>cargo>docker)에 따라 1개 선택 → 가중치 35%
 * - Stack Overflow  : 태그 질문 수         → 학습 수요     (가중치 25%)
 *
 * 신뢰도(confidence): 3가지 신호(GitHub, 다운로드, SO) 충족 수
 *   - high  : 3개 모두 보유
 *   - medium: 2개 보유
 *   - low   : 1개 이하
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DATA_PATH    = join(__dirname, "../data/trends.json");
const DOMAINS_PATH = join(__dirname, "../data/domains.json");

// ─────────────────────────────────────────
// 타입
// ─────────────────────────────────────────

interface Tech {
  name: string;
  github?: string;
  npm?: string;
  pypi?: string;
  cargo?: string;
  dockerhub?: string;
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

async function getPypiDownloads(pkg: string): Promise<number | null> {
  const res = await fetch(
    `https://pypistats.org/api/packages/${encodeURIComponent(pkg.toLowerCase())}/recent`
  );
  if (!res.ok) return null;
  const data = await res.json() as { data?: { last_week?: number } };
  return data.data?.last_week ?? null;
}

async function getCargoDownloads(crateName: string): Promise<number | null> {
  const res = await fetch(
    `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`,
    { headers: { "User-Agent": "tech-trends-collector/1.0 (https://github.com/klmhyeonwoo/tech-trends-collector)" } }
  );
  if (!res.ok) return null;
  const data = await res.json() as { crate?: { recent_downloads?: number } };
  return data.crate?.recent_downloads ?? null;
}

async function getDockerHubPulls(image: string): Promise<number | null> {
  const slashIdx  = image.indexOf("/");
  const namespace = slashIdx === -1 ? "library" : image.slice(0, slashIdx);
  const repo      = slashIdx === -1 ? image      : image.slice(slashIdx + 1);
  const res = await fetch(`https://hub.docker.com/v2/repositories/${namespace}/${repo}/`);
  if (!res.ok) return null;
  const data = await res.json() as { pull_count?: number };
  return data.pull_count ?? null;
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
  githubStars:    number | null;
  npmDownloads:   number | null;
  pypiDownloads:  number | null;
  cargoDownloads: number | null;
  dockerPulls:    number | null;
  soQuestions:    number | null;
}

interface MaxMetrics {
  githubStars:    number | null;
  npmDownloads:   number | null;
  pypiDownloads:  number | null;
  cargoDownloads: number | null;
  dockerPulls:    number | null;
  soQuestions:    number | null;
}

const maxOrNull = (values: (number | null)[]): number | null =>
  Math.max(...values.map((v) => v ?? 0)) || null;

/**
 * 다운로드 지표 정규화: npm > pypi > cargo > docker 우선순위
 * 각 소스는 도메인 내 동일 소스의 최대값으로 정규화 → 에코시스템 간 단위 불일치 방지
 */
function normalizeDownloads(metrics: Metrics, max: MaxMetrics): number | null {
  const norm = (v: number | null, m: number | null) =>
    v !== null && m ? Math.round((v / m) * 100) : null;

  return (
    norm(metrics.npmDownloads,   max.npmDownloads)   ??
    norm(metrics.pypiDownloads,  max.pypiDownloads)  ??
    norm(metrics.cargoDownloads, max.cargoDownloads) ??
    norm(metrics.dockerPulls,    max.dockerPulls)    ??
    null
  );
}

function calcScore(metrics: Metrics, max: MaxMetrics): number {
  const norm = (v: number | null, m: number | null) =>
    v !== null && m ? Math.round((v / m) * 100) : null;

  const scores = [
    { value: norm(metrics.githubStars, max.githubStars), weight: 0.4  },
    { value: normalizeDownloads(metrics, max),            weight: 0.35 },
    { value: norm(metrics.soQuestions, max.soQuestions),  weight: 0.25 },
  ].filter((s) => s.value !== null) as { value: number; weight: number }[];

  if (!scores.length) return 0;
  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
  return Math.round(scores.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight);
}

/** 신뢰도: 3가지 핵심 신호(GitHub·다운로드·SO) 중 확보한 수 */
function calcConfidence(metrics: Metrics): "high" | "medium" | "low" {
  const present = [
    metrics.githubStars,
    metrics.npmDownloads ?? metrics.pypiDownloads ?? metrics.cargoDownloads ?? metrics.dockerPulls,
    metrics.soQuestions,
  ].filter((v) => v !== null).length;

  if (present >= 3) return "high";
  if (present >= 2) return "medium";
  return "low";
}

/** 어떤 다운로드 소스를 사용했는지 표시 */
function downloadSource(metrics: Metrics): string {
  if (metrics.npmDownloads   !== null) return "npm";
  if (metrics.pypiDownloads  !== null) return "pypi";
  if (metrics.cargoDownloads !== null) return "cargo";
  if (metrics.dockerPulls    !== null) return "docker";
  return "-";
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
  rankChange: number | null;  // 양수: 상승, 음수: 하락, null: 신규
  name: string;
  score: number;
  confidence: "high" | "medium" | "low";
  metrics: Metrics;
}

interface DomainResult {
  label: string;
  updatedAt: string;
  rankings: Ranking[];
}

interface TrendsOutput {
  collectedAt: string;
  sources: string[];
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

    const [githubStars, npmDownloads, pypiDownloads, cargoDownloads, dockerPulls, soQuestions] =
      await Promise.all([
        tech.github    ? getGitHubStars(tech.github)       : Promise.resolve(null),
        tech.npm       ? getNpmDownloads(tech.npm)         : Promise.resolve(null),
        tech.pypi      ? getPypiDownloads(tech.pypi)       : Promise.resolve(null),
        tech.cargo     ? getCargoDownloads(tech.cargo)     : Promise.resolve(null),
        tech.dockerhub ? getDockerHubPulls(tech.dockerhub) : Promise.resolve(null),
        getSOCount(soTag),
      ]);

    const metrics: Metrics = { githubStars, npmDownloads, pypiDownloads, cargoDownloads, dockerPulls, soQuestions };
    const dlVal = npmDownloads ?? pypiDownloads ?? cargoDownloads ?? dockerPulls;
    const src   = downloadSource(metrics);

    console.log(
      `  ${tech.name.padEnd(20)} ★${String(githubStars ?? "-").padStart(8)} | ${src.padEnd(6)} ${String(dlVal ?? "-").padStart(12)} | SO ${String(soQuestions ?? "-").padStart(10)}`
    );

    raw.push({ name: tech.name, metrics });
    await new Promise((r) => setTimeout(r, 250));
  }

  // 소스별 최대값 (각 에코시스템 내에서 독립 정규화)
  const max: MaxMetrics = {
    githubStars:    maxOrNull(raw.map((r) => r.metrics.githubStars)),
    npmDownloads:   maxOrNull(raw.map((r) => r.metrics.npmDownloads)),
    pypiDownloads:  maxOrNull(raw.map((r) => r.metrics.pypiDownloads)),
    cargoDownloads: maxOrNull(raw.map((r) => r.metrics.cargoDownloads)),
    dockerPulls:    maxOrNull(raw.map((r) => r.metrics.dockerPulls)),
    soQuestions:    maxOrNull(raw.map((r) => r.metrics.soQuestions)),
  };

  const sorted = raw
    .map((r) => ({ ...r, score: calcScore(r.metrics, max) }))
    .sort((a, b) => b.score - a.score);

  const rankings: Ranking[] = sorted.map((r, i) => {
    const currentRank = i + 1;
    const prev = prevRanks[r.name];
    return {
      rank:       currentRank,
      rankChange: prev != null ? prev - currentRank : null,
      name:       r.name,
      score:      r.score,
      confidence: calcConfidence(r.metrics),
      metrics:    r.metrics,
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
  console.log("소스: GitHub Stars · npm · PyPI · crates.io · Docker Hub · Stack Overflow");

  const DOMAINS    = loadDomains();
  const totalTechs = Object.values(DOMAINS).reduce((s, d) => s + d.techs.length, 0);
  console.log(`\n추적 기술: ${totalTechs}개 (${Object.keys(DOMAINS).length}개 도메인)\n`);

  const domains: Record<string, DomainResult> = {};

  for (const [key, config] of Object.entries(DOMAINS)) {
    domains[key] = await collectDomain(key, config);
  }

  const output: TrendsOutput = {
    collectedAt: new Date().toISOString(),
    sources: ["GitHub Stars", "npm weekly downloads", "PyPI weekly downloads", "crates.io recent downloads", "Docker Hub pull count", "Stack Overflow question count"],
    domains,
  };

  writeFileSync(DATA_PATH, JSON.stringify(output, null, 2), "utf-8");

  console.log("\n" + "=".repeat(60));
  console.log("✅ 저장 완료: data/trends.json");
  console.log("\n도메인별 TOP 3:");
  for (const [, result] of Object.entries(domains)) {
    const top3 = result.rankings.slice(0, 3)
      .map((r) => `${r.name}(${r.score},${r.confidence[0].toUpperCase()})`)
      .join(", ");
    console.log(`  ${result.label}: ${top3}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
