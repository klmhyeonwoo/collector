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
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DATA_PATH = join(__dirname, "../data/trends.json");

// ─────────────────────────────────────────
// 기술 목록
// ─────────────────────────────────────────

interface Tech {
  name: string;
  github?: string;  // "owner/repo"
  npm?: string;     // npm package name
  so?: string;      // Stack Overflow 태그 (없으면 name 소문자)
}

interface DomainConfig {
  label: string;
  techs: Tech[];
}

const DOMAINS: Record<string, DomainConfig> = {
  frontend: {
    label: "프론트엔드",
    techs: [
      { name: "React",        github: "facebook/react",             npm: "react" },
      { name: "Vue.js",       github: "vuejs/core",                 npm: "vue",              so: "vue.js" },
      { name: "Svelte",       github: "sveltejs/svelte",            npm: "svelte" },
      { name: "Angular",      github: "angular/angular",            npm: "@angular/core" },
      { name: "Next.js",      github: "vercel/next.js",             npm: "next",             so: "next.js" },
      { name: "Nuxt",         github: "nuxt/nuxt",                  npm: "nuxt" },
      { name: "Astro",        github: "withastro/astro",            npm: "astro" },
      { name: "Remix",        github: "remix-run/remix",            npm: "@remix-run/react" },
      { name: "TypeScript",   github: "microsoft/TypeScript",       npm: "typescript" },
      { name: "Vite",         github: "vitejs/vite",                npm: "vite" },
      { name: "Tailwind CSS", github: "tailwindlabs/tailwindcss",   npm: "tailwindcss",      so: "tailwind-css" },
      { name: "shadcn/ui",    github: "shadcn-ui/ui",               npm: undefined },
    ],
  },

  backend: {
    label: "백엔드",
    techs: [
      { name: "Node.js",      github: "nodejs/node",                                         so: "node.js" },
      { name: "Deno",         github: "denoland/deno" },
      { name: "Bun",          github: "oven-sh/bun" },
      { name: "Express",      github: "expressjs/express",          npm: "express" },
      { name: "Fastify",      github: "fastify/fastify",            npm: "fastify" },
      { name: "NestJS",       github: "nestjs/nest",                npm: "@nestjs/core",     so: "nestjs" },
      { name: "Hono",         github: "honojs/hono",                npm: "hono" },
      { name: "FastAPI",      github: "tiangolo/fastapi",                                    so: "fastapi" },
      { name: "Django",       github: "django/django",                                       so: "django" },
      { name: "Spring Boot",  github: "spring-projects/spring-boot",                        so: "spring-boot" },
      { name: "Gin",          github: "gin-gonic/gin",                                       so: "go-gin" },
      { name: "Axum",         github: "tokio-rs/axum",                                       so: "axum" },
    ],
  },

  devops: {
    label: "데브옵스",
    techs: [
      { name: "Docker",           github: "docker/compose",                                  so: "docker" },
      { name: "Kubernetes",       github: "kubernetes/kubernetes",                           so: "kubernetes" },
      { name: "Terraform",        github: "hashicorp/terraform",                             so: "terraform" },
      { name: "Pulumi",           github: "pulumi/pulumi",                                   so: "pulumi" },
      { name: "ArgoCD",           github: "argoproj/argo-cd",                               so: "argo-cd" },
      { name: "GitHub Actions",   github: "actions/runner",                                  so: "github-actions" },
      { name: "Helm",             github: "helm/helm",                                       so: "kubernetes-helm" },
      { name: "Prometheus",       github: "prometheus/prometheus",                           so: "prometheus" },
      { name: "Grafana",          github: "grafana/grafana",                                 so: "grafana" },
    ],
  },

  mobile: {
    label: "모바일",
    techs: [
      { name: "React Native",     github: "facebook/react-native",  npm: "react-native",    so: "react-native" },
      { name: "Flutter",          github: "flutter/flutter",                                 so: "flutter" },
      { name: "Swift",            github: "swiftlang/swift",                                 so: "swift" },
      { name: "Kotlin",           github: "JetBrains/kotlin",                               so: "kotlin" },
      { name: "Expo",             github: "expo/expo",              npm: "expo" },
      { name: "Capacitor",        github: "ionic-team/capacitor",   npm: "@capacitor/core" },
    ],
  },

  ai: {
    label: "AI / ML",
    techs: [
      { name: "LangChain",        github: "langchain-ai/langchain", npm: "langchain" },
      { name: "LlamaIndex",       github: "run-llama/llama_index",  npm: "llamaindex" },
      { name: "Transformers",     github: "huggingface/transformers",                        so: "huggingface-transformers" },
      { name: "PyTorch",          github: "pytorch/pytorch",                                 so: "pytorch" },
      { name: "TensorFlow",       github: "tensorflow/tensorflow",                           so: "tensorflow" },
      { name: "Ollama",           github: "ollama/ollama" },
      { name: "LiteLLM",          github: "BerriAI/litellm",        npm: undefined },
      { name: "Vercel AI SDK",    github: "vercel/ai",              npm: "ai" },
    ],
  },

  database: {
    label: "데이터베이스",
    techs: [
      { name: "PostgreSQL",       github: "postgres/postgres",                               so: "postgresql" },
      { name: "MySQL",            github: "mysql/mysql-server",                              so: "mysql" },
      { name: "MongoDB",          github: "mongodb/mongo",                                   so: "mongodb" },
      { name: "Redis",            github: "redis/redis",                                     so: "redis" },
      { name: "Elasticsearch",    github: "elastic/elasticsearch",                           so: "elasticsearch" },
      { name: "Supabase",         github: "supabase/supabase",      npm: "@supabase/supabase-js" },
      { name: "Prisma",           github: "prisma/prisma",          npm: "prisma" },
      { name: "DrizzleORM",       github: "drizzle-team/drizzle-orm", npm: "drizzle-orm" },
      { name: "Turso",            github: "tursodatabase/turso-client-ts", npm: "@libsql/client" },
    ],
  },

  testing: {
    label: "테스팅",
    techs: [
      { name: "Vitest",           github: "vitest-dev/vitest",      npm: "vitest" },
      { name: "Jest",             github: "jestjs/jest",            npm: "jest" },
      { name: "Playwright",       github: "microsoft/playwright",   npm: "playwright" },
      { name: "Cypress",          github: "cypress-io/cypress",     npm: "cypress" },
      { name: "Storybook",        github: "storybookjs/storybook",  npm: "@storybook/react", so: "storybook" },
      { name: "Testing Library",  github: "testing-library/react-testing-library", npm: "@testing-library/react" },
    ],
  },

  language: {
    label: "프로그래밍 언어",
    techs: [
      { name: "Rust",             github: "rust-lang/rust",                                  so: "rust" },
      { name: "Go",               github: "golang/go",                                       so: "go" },
      { name: "Python",           github: "python/cpython",                                  so: "python" },
      { name: "Kotlin",           github: "JetBrains/kotlin",                               so: "kotlin" },
      { name: "Swift",            github: "swiftlang/swift",                                 so: "swift" },
      { name: "Zig",              github: "ziglang/zig",                                     so: "zig" },
      { name: "Elixir",           github: "elixir-lang/elixir",                             so: "elixir" },
    ],
  },
};

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
