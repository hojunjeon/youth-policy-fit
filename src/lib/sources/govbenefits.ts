import type { Connector } from "@/lib/sources/types";
import type { Policy } from "@/lib/types";
import { parseEligibilityText, toRuleFragment, isYouthRelevant } from "@/lib/sources/parseEligibility";
import { toCategoryFromText, pick, splitChecklist, parseApplyWindow, capList, stringifyRecord } from "@/lib/sources/normalize";

// 행정안전부 "대한민국 공공서비스(혜택)" API (data.go.kr/data/15113968).
// 보조금24의 데이터 원천으로, odcloud 게이트웨이(api.odcloud.kr)의 gov24 v3 API로 서비스된다.
//
// 엔드포인트 검증: 2026-08-17, WebFetch + curl로 실제 호출해 확인.
//   curl "https://api.odcloud.kr/api/gov24/v3/serviceList?page=1&perPage=1&serviceKey=test"
//   → HTTP 401 {"code":-4,"msg":"등록되지 않은 인증키 입니다."}
// 즉 경로("/api/gov24/v3/serviceList")와 파라미터 형식(page, perPage, serviceKey 쿼리)은
// 실제로 존재함이 확인됐다. 단, 유효한 키가 없어 실제 응답 바디(필드명)는 확인하지 못했다.
// 아래 필드명은 data.go.kr 상세 페이지에 명시된 항목(서비스명/지원대상/선정기준/신청방법/
// 지원내용/소관기관)을 표준 gov24 스펙 기준으로 추정한 것이며, 여러 표기 후보를 함께 두어
// 실제 키가 조금 달라도 견딜 수 있게 했다. *** 실 키 발급 후 첫 호출 시 반드시 응답을 로깅해
// 필드명이 맞는지 검증할 것. ***
const ENDPOINT = "https://api.odcloud.kr/api/gov24/v3/serviceList";

interface RawItem {
  [key: string]: unknown;
}

function pickId(item: RawItem): string | undefined {
  return pick(item, ["서비스ID", "서비스아이디", "id", "ID"]);
}

function normalize(raw: RawItem, today: string): Policy | null {
  // odcloud 응답은 서비스ID 등 일부 필드를 숫자로 내려줄 수 있는데, pick()은 문자열만
  // 인식해 그 필드를 무시하고 항목 자체를 통째로 드롭시킨다. welfare.ts와 동일한 방식으로
  // 얕게 문자열화해 넘긴다.
  const item = stringifyRecord(raw);
  const id = pickId(item);
  const name = pick(item, ["서비스명"]);
  if (!id || !name) return null;

  const target = pick(item, ["지원대상", "대상"]) ?? "";
  const criteria = pick(item, ["선정기준"]) ?? "";
  const eligibilityText = [target, criteria].filter(Boolean).join(" ");
  const benefit = pick(item, ["지원내용", "지원 내용", "서비스목적요약"]) ?? "";
  const method = pick(item, ["신청방법"]);
  const agency = pick(item, ["소관기관명", "소관기관", "부서명", "접수기관명"]) ?? "행정안전부";
  const deadline = pick(item, ["신청기한", "접수기간"]);
  const url = pick(item, ["상세조회URL", "온라인신청사이트URL", "서비스상세링크"]) ?? "https://www.gov.kr/gov24";
  const fieldText = pick(item, ["서비스분야", "지원유형"]);

  if (!isYouthRelevant(eligibilityText, parseEligibilityText(eligibilityText))) return null;

  return {
    id: `gb-${id}`,
    name,
    agency,
    category: toCategoryFromText(fieldText ?? name),
    summary: (benefit || target).slice(0, 80),
    benefit: benefit.slice(0, 200) || "지원 내용은 공고 원문 확인",
    rule: toRuleFragment(parseEligibilityText(eligibilityText), eligibilityText || name),
    apply: parseApplyWindow(deadline),
    checklist: splitChecklist(method, "공고 원문에서 신청 방법 확인"),
    url,
    source: "govbenefits",
    updatedAt: today,
  };
}

export async function fetchGovBenefitsPolicies(apiKey: string, signal?: AbortSignal): Promise<Policy[]> {
  const params = new URLSearchParams({ page: "1", perPage: "200", serviceKey: apiKey });
  const res = await fetch(`${ENDPOINT}?${params}`, { next: { revalidate: 3600 }, signal });
  if (!res.ok) throw new Error(`govbenefits API ${res.status}`);
  const json = await res.json();
  const list: RawItem[] = json?.data ?? json?.result?.data ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const normalized = list.map((r) => normalize(r, today)).filter((p): p is Policy => p !== null);
  return capList(normalized, 200);
}

export const govbenefitsConnector: Connector = {
  id: "govbenefits",
  name: "공공서비스(혜택)",
  requiredEnv: "DATA_GO_KR_API_KEY",
  fetchPolicies: fetchGovBenefitsPolicies,
};
