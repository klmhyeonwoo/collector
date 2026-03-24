/**
 * 신규 기술 발견 스크립트
 *
 * 1. GitHub API에서 이번 주 급상승 레포 수집
 * 2. Hacker News에서 화제 기술 게시물 수집
 * 3. Gemini로 기술 분류 → 기존 목록에 없는 신규 기술만 추출
 * 4. domains.json에 신규 기술 자동 추가
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DOMAINS_PATH   = join(__dirname, "../data/domains.json");

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY 환경변수가 없습니다.");
  process.exit(1);
}

async function callGemini(prompt: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API 오류 ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  return data.candidates[0].content.parts[0].text;
}

// ─────────────────────────────────────────
// 타입
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

type DomainsMap = Record<string, DomainConfig>;

// ─────────────────────────────────────────
// domains.json 로드 / 저장
// ─────────────────────────────────────────

function loadDomains(): DomainsMap {
  if (existsSync(DOMAINS_PATH)) {
    return JSON.parse(readFileSync(DOMAINS_PATH, "utf-8")) as DomainsMap;
  }
  // domains.json이 없으면 collect.ts의 DEFAULT_DOMAINS를 읽어서 초기화
  const collectSrc = readFileSync(join(__dirname, "./collect.ts"), "utf-8");
  const match = collectSrc.match(/const DEFAULT_DOMAINS[\s\S]*?^};/m);
  if (!match) throw new Error("DEFAULT_DOMAINS를 collect.ts에서 찾을 수 없습니다. npm run collect를 먼저 실행하세요.");
  throw new Error("data/domains.json이 없습니다. npm run collect를 먼저 실행하세요.");
}

function saveDomains(domains: DomainsMap): void {
  writeFileSync(DOMAINS_PATH, JSON.stringify(domains, null, 2), "utf-8");
}

// ─────────────────────────────────────────
// 1. GitHub — 이번 주 급상승 레포 수집
// ─────────────────────────────────────────

interface GithubRepo {
  full_name: string;
  name: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  topics: string[];
}

async function fetchGitHubTrending(): Promise<GithubRepo[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(
    `https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=50`,
    { headers }
  );
  if (!res.ok) {
    console.warn("GitHub API 호출 실패:", res.status);
    return [];
  }

  const data = await res.json() as { items: GithubRepo[] };
  console.log(`  GitHub: ${data.items.length}개 레포 수집`);
  return data.items;
}

// ─────────────────────────────────────────
// 2. Hacker News — 이번 주 화제 게시물 수집
// ─────────────────────────────────────────

interface HNHit {
  title: string;
  url: string | null;
  points: number;
}

async function fetchHackerNewsTrending(): Promise<HNHit[]> {
  const since = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);

  const res = await fetch(
    `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${since},points>50&hitsPerPage=50`
  );
  if (!res.ok) {
    console.warn("HN API 호출 실패:", res.status);
    return [];
  }

  const data = await res.json() as { hits: HNHit[] };
  console.log(`  HackerNews: ${data.hits.length}개 게시물 수집`);
  return data.hits;
}

// ─────────────────────────────────────────
// 3. Gemini — 신규 기술 분류
// ─────────────────────────────────────────

interface DiscoveredTech {
  name: string;
  domain: string;  // 기존 도메인 키 (frontend, backend, ...)
  github?: string;
  npm?: string;
  so?: string;
  reason: string;  // 왜 추가했는지
}

async function classifyWithGemini(
  repos: GithubRepo[],
  hnPosts: HNHit[],
  existingTechNames: string[]
): Promise<DiscoveredTech[]> {
  const repoList = repos
    .map((r) => `- ${r.full_name} (★${r.stargazers_count}): ${r.description ?? ""}`)
    .join("\n");

  const hnList = hnPosts
    .map((h) => `- ${h.title} (${h.points}pts)`)
    .join("\n");

  const existingList = existingTechNames.join(", ");

  const prompt = `
당신은 기술 트렌드 분석가입니다.

아래는 이번 주 GitHub에서 급상승한 레포와 Hacker News 화제 게시물입니다.
이 중에서 개발자 도구, 프레임워크, 라이브러리, 프로그래밍 언어에 해당하는 기술을 찾아주세요.

## 이번 주 GitHub 급상승 레포
${repoList}

## 이번 주 Hacker News 화제 게시물
${hnList}

## 이미 추적 중인 기술 (제외)
${existingList}

## 지시사항
1. 위 소스에서 개발 기술(프레임워크, 라이브러리, 언어, 도구)에 해당하는 것만 골라주세요
2. 이미 추적 중인 기술은 제외하세요
3. 아래 도메인 중 하나로 분류하세요:
   - frontend: UI 프레임워크, CSS 도구, 빌드 도구
   - backend: 서버 프레임워크, 런타임, API 도구
   - devops: CI/CD, 컨테이너, 인프라, 모니터링
   - mobile: 모바일 앱 개발
   - ai: AI/ML 프레임워크, LLM 도구
   - database: DB, ORM, 데이터 스토리지
   - testing: 테스트 프레임워크, E2E 도구
   - language: 프로그래밍 언어
4. 확실하지 않거나 단순 앱/프로젝트인 경우 제외하세요

## 응답 형식 (JSON 배열만 반환, 설명 없이)
[
  {
    "name": "기술명",
    "domain": "도메인키",
    "github": "owner/repo",
    "npm": "npm패키지명 또는 null",
    "so": "스택오버플로우 태그 또는 null",
    "reason": "추가 이유 한 줄"
  }
]
`;

  const text = (await callGemini(prompt)).trim();

  // JSON 블록 추출
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn("Gemini 응답에서 JSON을 찾을 수 없습니다.");
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as DiscoveredTech[];
    return parsed.filter((t) => t.name && t.domain);
  } catch {
    console.warn("Gemini 응답 파싱 실패");
    return [];
  }
}

// ─────────────────────────────────────────
// 메인
// ─────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("신규 기술 발견 시작");
  console.log("=".repeat(60));

  // domains.json 로드
  const domains = loadDomains();
  const existingNames = Object.values(domains)
    .flatMap((d) => d.techs.map((t) => t.name));

  console.log(`\n현재 추적 중인 기술: ${existingNames.length}개`);

  // 데이터 수집
  console.log("\n[1] 소스 수집 중...");
  const [repos, hnPosts] = await Promise.all([
    fetchGitHubTrending(),
    fetchHackerNewsTrending(),
  ]);

  // Gemini 분류
  console.log("\n[2] Gemini로 신규 기술 분류 중...");
  const discovered = await classifyWithGemini(repos, hnPosts, existingNames);

  if (discovered.length === 0) {
    console.log("\n이번 주 신규 기술 없음");
    saveDomains(domains);
    return;
  }

  // 도메인에 추가
  let addedCount = 0;
  for (const tech of discovered) {
    const domain = domains[tech.domain];
    if (!domain) continue;

    // 중복 체크
    const alreadyExists = domain.techs.some(
      (t) => t.name.toLowerCase() === tech.name.toLowerCase()
    );
    if (alreadyExists) continue;

    const newTech: Tech = { name: tech.name };
    if (tech.github) newTech.github = tech.github;
    if (tech.npm)    newTech.npm    = tech.npm;
    if (tech.so)     newTech.so     = tech.so;

    domain.techs.push(newTech);
    addedCount++;
    console.log(`  + [${tech.domain}] ${tech.name} — ${tech.reason}`);
  }

  saveDomains(domains);

  console.log("\n" + "=".repeat(60));
  console.log(`✅ 신규 기술 ${addedCount}개 추가 완료 → data/domains.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
