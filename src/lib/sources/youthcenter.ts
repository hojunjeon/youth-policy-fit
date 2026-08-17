import type { Connector } from "@/lib/sources/types";
import type { Policy } from "@/lib/types";
import { decodeEntities } from "@/lib/sources/normalize";

// 온통청년(청년정책 통합 플랫폼) Open API 어댑터.
//
// 사용법:
//   1. https://www.youthcenter.go.kr 회원가입 → 마이페이지 → 오픈 API 인증키 발급
//   2. 프로젝트 루트 .env.local 에 YOUTHCENTER_API_KEY=발급받은키 추가
//   3. 서버 재시작 → /api/policies 가 자동으로 실 API 데이터를 병합
//
// 엔드포인트·필드명은 2024년 개편된 청년정책 조회 API(getPlcy) 기준이며,
// 스펙이 바뀌면 이 파일만 고치면 된다. 실패 시 호출부에서 시드 데이터로 폴백한다.

const ENDPOINT = "https://www.youthcenter.go.kr/go/ythip/getPlcy";

interface RawPolicy {
  plcyNo?: string;
  plcyNm?: string;
  plcyExplnCn?: string;
  plcySprtCn?: string;
  sprvsnInstCdNm?: string;
  lclsfNm?: string;
  sprtTrgtMinAge?: string;
  sprtTrgtMaxAge?: string;
  zipCd?: string;
  aplyYmd?: string; // "20260101 ~ 20261231" 형태
  aplyUrlAddr?: string;
  plcyAplyMthdCn?: string;
}

function toCategory(lclsf?: string): Policy["category"] {
  if (!lclsf) return "복지·문화";
  if (lclsf.includes("일자리")) return "일자리";
  if (lclsf.includes("주거")) return "주거";
  if (lclsf.includes("교육")) return "교육";
  if (lclsf.includes("창업")) return "창업";
  if (lclsf.includes("금융") || lclsf.includes("자산")) return "금융·자산";
  return "복지·문화";
}

function parseDate(s?: string): string | undefined {
  if (!s || s.length < 8) return undefined;
  const d = s.replace(/[^0-9]/g, "").slice(0, 8);
  if (d.length !== 8) return undefined;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

// "0"(연령 무관)은 진짜 하한/상한이 아니라 "제한 없음"이므로 규칙에 반영하면 안 된다.
// "0"은 자바스크립트에서 truthy string이지만 Number("0") === 0 이라 age-unlimited API
// 응답이 minAge:0, maxAge:0 으로 들어와 모든 사용자가 차단되는 문제를 막는다.
function parsePositiveAge(s?: string): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// 구 법정동코드 잔재 대응: 2023년 개편 이후에도 일부 응답이 옛 코드를 내려준다.
const LEGACY_SIDO_MAP: Record<string, string> = {
  "42": "51", // 강원도 → 강원특별자치도
  "45": "52", // 전라북도 → 전북특별자치도
};

function normalizeSidoCode(code: string): string {
  return LEGACY_SIDO_MAP[code] ?? code;
}

function normalize(raw: RawPolicy, today: string): Policy | null {
  if (!raw.plcyNo || !raw.plcyNm) return null;
  const [startRaw, endRaw] = (raw.aplyYmd ?? "").split("~").map((s) => s.trim());
  const start = parseDate(startRaw);
  const end = parseDate(endRaw);
  const sidoSet = new Set(
    (raw.zipCd ?? "")
      .split(",")
      .map((z) => z.trim().slice(0, 2))
      .filter((z) => /^\d{2}$/.test(z))
      .map(normalizeSidoCode),
  );
  // 이 API는 JSON으로 오지만, 원 데이터가 XML 파이프라인을 한 번 거쳐 이중 인코딩된
  // 엔티티(&amp;#39; 등)를 문자열 값 그대로 담고 있는 경우가 있다 — 다른 커넥터와 동일하게
  // 사람이 읽는 텍스트 필드에는 decodeEntities를 적용한다(ID·날짜·코드류는 대상 아님).
  return {
    id: `yc-${raw.plcyNo}`,
    name: decodeEntities(raw.plcyNm),
    agency: raw.sprvsnInstCdNm ? decodeEntities(raw.sprvsnInstCdNm) : "온통청년",
    category: toCategory(raw.lclsfNm),
    summary: decodeEntities(raw.plcyExplnCn ?? "").slice(0, 80),
    benefit: decodeEntities(raw.plcySprtCn ?? "").slice(0, 200),
    rule: {
      minAge: parsePositiveAge(raw.sprtTrgtMinAge),
      maxAge: parsePositiveAge(raw.sprtTrgtMaxAge),
      sido: sidoSet.size > 0 ? [...sidoSet] : undefined,
      note: "세부 요건은 공고 원문 확인",
    },
    apply: end ? { kind: "기간", start, end } : { kind: "상시" },
    checklist: raw.plcyAplyMthdCn ? [decodeEntities(raw.plcyAplyMthdCn).slice(0, 100)] : ["공고 원문에서 신청 방법 확인"],
    url: raw.aplyUrlAddr || `https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch`,
    source: "youthcenter",
    updatedAt: today,
  };
}

export async function fetchYouthcenterPolicies(apiKey: string, signal?: AbortSignal): Promise<Policy[]> {
  const params = new URLSearchParams({
    apiKeyNm: apiKey,
    rtnType: "json",
    pageNum: "1",
    pageSize: "100",
  });
  const res = await fetch(`${ENDPOINT}?${params}`, { next: { revalidate: 3600 }, signal });
  if (!res.ok) throw new Error(`youthcenter API ${res.status}`);
  const json = await res.json();
  const list: RawPolicy[] = json?.result?.youthPolicyList ?? json?.youthPolicyList ?? [];
  const today = new Date().toISOString().slice(0, 10);
  return list.map((r) => normalize(r, today)).filter((p): p is Policy => p !== null);
}

export const youthcenterConnector: Connector = {
  id: "youthcenter",
  name: "온통청년",
  requiredEnv: "YOUTHCENTER_API_KEY",
  fetchPolicies: fetchYouthcenterPolicies,
};
