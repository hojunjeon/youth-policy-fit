import { NextResponse } from "next/server";
import { SEED_POLICIES } from "@/data/policies";
import { CONNECTORS } from "@/lib/sources/registry";
import type { SourceStatus } from "@/lib/sources/types";
import type { Policy } from "@/lib/types";

// 정책 데이터 소스 단일 진입점.
// 등록된 모든 커넥터(온통청년/공공서비스혜택/복지로/K-스타트업)를 병렬로 호출해 시드와 병합한다.
// 키가 없는 커넥터는 "no-key", 호출이 실패한 커넥터는 "error"로 상태를 보고하되 전체 응답은
// 항상 200으로 내려준다 — 정책 매칭 UI가 부분 실패에도 계속 동작해야 하기 때문이다.

// 정책명 정규화 — 공백과 괄호 안 부가 설명을 제거해 서로 다른 소스의 같은 정책을 매칭한다.
// 예: "청년도약계좌 (5년형)" → "청년도약계좌"
function normalizePolicyName(name: string): string {
  return name.replace(/\([^)]*\)/g, "").replace(/\s+/g, "");
}

// 라우트 레벨 캐시: 모듈 스코프 메모 + 30분 TTL.
// Next 16에서 unstable_cache는 "use cache" 디렉티브로 대체 권고되지만, 이 디렉티브는
// Cache Components(next.config.ts의 cacheComponents 플래그)를 켜야 정식 동작하고 이 프로젝트는
// 아직 그 플래그를 쓰지 않는다. 라우트 핸들러 본문 안에서 곧바로 "use cache"를 쓸 수도 없어
// 별도 헬퍼로 빼야 하는 번거로움도 있다. 대신 프로세스 메모리에 마지막 성공 응답을 30분간
// 재사용하는 단순한 모듈 레벨 캐시를 쓴다 — 개발 서버 재시작/서버리스 콜드스타트 시에는
// 자연히 캐시가 비워지고, 그 밖에는 외부 API를 매 요청마다 두드리지 않게 해준다.
const CACHE_TTL_MS = 30 * 60 * 1000;
// 라이브 커넥터가 전부 실패(error)했는데 30분씩 캐시하면 다음 요청도 그 실패를 그대로
// 30분간 물려받는다. "ok"가 하나도 없고 "error"가 하나라도 있는 상태는 짧게만 캐시해
// 다음 요청이 곧 다시 시도하게 한다. "no-key"만 있는 상태(키를 아예 등록 안 한 설치)는
// 안정적인 상태이므로 그대로 30분 캐시해도 된다.
const ERROR_CACHE_TTL_MS = 60 * 1000;
let cache: { data: { sources: SourceStatus[]; policies: Policy[] }; expiresAt: number } | null = null;
// 콜드 스타트 시 동시에 들어온 N개의 요청이 캐시가 빌 때마다 각자 커넥터를 N번씩 호출하는
// 것을 막기 위해, 진행 중인 로드 하나를 모든 동시 요청이 공유한다.
let inFlight: Promise<{ sources: SourceStatus[]; policies: Policy[] }> | null = null;

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error(`connector timeout after ${ms}ms`)));
  });
  try {
    // run()에 같은 controller의 signal을 넘겨 타임아웃이 fetch 자체를 중단시키게 한다 —
    // 그러지 않으면 바깥의 Promise.race는 타임아웃 시 즉시 리턴하지만 내부 fetch 소켓은
    // 8초 뒤에도 계속 열려 있게 된다.
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function cacheTtlMsFor(sources: SourceStatus[]): number {
  const live = sources.filter((s) => s.id !== "seed");
  const hasOk = live.some((s) => s.status === "ok");
  if (hasOk) return CACHE_TTL_MS;
  const hasError = live.some((s) => s.status === "error");
  return hasError ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
}

async function loadAll(): Promise<{ sources: SourceStatus[]; policies: Policy[] }> {
  const outcomes = await Promise.allSettled(
    CONNECTORS.map(async (connector) => {
      // optionalEnv는 requiredEnv와 달리 키가 없어도 커넥터를 실행한다 — 키가 있으면
      // fetchPolicies에 함께 전달해 요청에 실어 보내되(예: serviceKey), 없어도 무키로 시도한다.
      const envName = connector.requiredEnv ?? connector.optionalEnv;
      const key = envName ? process.env[envName] : undefined;
      if (connector.requiredEnv && !key) {
        return { status: "no-key" as const, policies: [] as Policy[] };
      }
      try {
        const policies = await withTimeout((signal) => connector.fetchPolicies(key ?? "", signal), 8000);
        return { status: "ok" as const, policies };
      } catch (e) {
        console.error(`${connector.id} 커넥터 호출 실패:`, e);
        return { status: "error" as const, policies: [] as Policy[] };
      }
    }),
  );

  const sources: SourceStatus[] = [];
  const livePolicies: Policy[] = [];
  outcomes.forEach((outcome, i) => {
    const connector = CONNECTORS[i];
    // 커넥터 내부에서 이미 try/catch로 감쌌으므로 allSettled의 rejected 분기는
    // 실질적으로 도달하지 않지만, 예상 못 한 동기 예외에 대한 안전망으로 남겨둔다.
    if (outcome.status === "fulfilled") {
      sources.push({ id: connector.id, name: connector.name, status: outcome.value.status, count: outcome.value.policies.length });
      livePolicies.push(...outcome.value.policies);
    } else {
      sources.push({ id: connector.id, name: connector.name, status: "error", count: 0 });
    }
  });

  // 라이브 소스끼리 같은 정책명이 겹치면 registry 순서상 먼저 등록된 소스를 우선한다.
  const seenLive = new Set<string>();
  const dedupedLive: Policy[] = [];
  for (const p of livePolicies) {
    const key = normalizePolicyName(p.name);
    if (seenLive.has(key)) continue;
    seenLive.add(key);
    dedupedLive.push(p);
  }

  // 시드는 라이브 데이터와 이름이 겹치면 제거(라이브가 우선)한다.
  const liveNames = new Set(dedupedLive.map((p) => normalizePolicyName(p.name)));
  const dedupedSeeds = SEED_POLICIES.filter((p) => !liveNames.has(normalizePolicyName(p.name)));
  sources.push({ id: "seed", name: "내장 데이터", status: "ok", count: dedupedSeeds.length });

  return { sources, policies: [...dedupedSeeds, ...dedupedLive] };
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.data);
  }

  if (!inFlight) {
    inFlight = loadAll().finally(() => {
      inFlight = null;
    });
  }
  const data = await inFlight;
  cache = { data, expiresAt: Date.now() + cacheTtlMsFor(data.sources) };
  return NextResponse.json(data);
}
