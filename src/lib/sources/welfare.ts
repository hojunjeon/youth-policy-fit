import { XMLParser } from "fast-xml-parser";
import type { Connector } from "@/lib/sources/types";
import type { Policy } from "@/lib/types";
import { parseEligibilityText, toRuleFragment, isYouthRelevant } from "@/lib/sources/parseEligibility";
import { toCategoryFromText, pick, splitChecklist, parseApplyWindow, capList, asArray, stringifyRecord } from "@/lib/sources/normalize";

// 복지로(한국사회보장정보원) 중앙부처/지자체 복지서비스 API.
//   중앙부처: data.go.kr/data/15090532
//   지자체:   data.go.kr/data/15108347
// 둘 다 서비스명 "한국사회보장정보원_○○복지서비스", XML 응답, 서비스키는 공공데이터포털
// 공용 키(DATA_GO_KR_API_KEY)를 그대로 쓴다.
//
// 엔드포인트 검증: 2026-08-17, curl로 실제 호출해 확인.
//   curl "http://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfarelistV001?serviceKey=test"
//   → HTTP 403 <errMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</errMsg> (경로 자체는 유효, 키만 미등록)
//   curl "http://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist?serviceKey=test"
//   → 동일하게 경로 유효 확인.
// 상세조회(NationalWelfaredetailedV001/LcgvWelfaredetailed)는 항목마다 별도 호출이 필요해
// 200개 캡·8초 타임아웃 안에서는 비효율적이라 호출하지 않았다. 아래 필드명은 목록조회
// 응답에 실제로 포함되는지 유효한 키로 확인하지 못했으므로, 데이터 페이지에 적힌 항목명
// (서비스명/지원대상/선정기준/신청방법)과 이 API 계열에서 흔히 쓰이는 영문 필드명 후보를
// 함께 두었다. *** 실 키 발급 후 첫 호출 시 응답을 로깅해 필드명을 검증할 것. ***
const CENTRAL_ENDPOINT = "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfarelistV001";
const LOCAL_ENDPOINT = "https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist";

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

interface RawItem {
  [key: string]: unknown;
}

// 필드명이 실 키로 검증되지 않은 추정 스펙이라, 잘못된 필드를 잘못 해석해 부적합한
// 항목을 대량으로 끌어올 위험을 줄이기 위해 요청당 개수를 200에서 50으로 낮춘다.
// (route.ts의 200건 캡은 그대로 유지 — 두 엔드포인트 합쳐도 100건이라 안전망 역할.)
async function fetchList(endpoint: string, apiKey: string, signal?: AbortSignal): Promise<RawItem[]> {
  const params = new URLSearchParams({ serviceKey: apiKey, pageNo: "1", numOfRows: "50" });
  const res = await fetch(`${endpoint}?${params}`, { next: { revalidate: 3600 }, signal });
  if (!res.ok) throw new Error(`welfare API ${res.status}`);
  const xml = await res.text();
  const json = parser.parse(xml);
  const items = json?.response?.body?.items?.item ?? json?.wantedList?.item ?? [];
  return asArray(items);
}

function normalize(raw: RawItem, idPrefix: string, agencyFallback: string, today: string): Policy | null {
  const item = stringifyRecord(raw);
  const id = pick(item, ["servId", "서비스ID", "wantedId", "id"]);
  const name = pick(item, ["servNm", "서비스명", "wantedTitle"]);
  if (!id || !name) return null;

  const target = pick(item, ["지원대상", "aplyTrgtCn", "trgterIndAtdcs", "trgterIndAtdcsNmList"]) ?? "";
  const criteria = pick(item, ["선정기준", "slctCrit"]) ?? "";
  const eligibilityText = [target, criteria].filter(Boolean).join(" ");
  const benefit = pick(item, ["servDgst", "지원내용", "alwServCn"]) ?? "";
  const method = pick(item, ["신청방법", "aplyMtdNm"]);
  const agency = pick(item, ["소관기관명", "jurMnofNm", "jurOrgNm"]) ?? agencyFallback;
  const period = pick(item, ["신청기한", "sprtCycNm"]);
  const url = pick(item, ["servDtlLink", "servURL"]) ?? "https://www.bokjiro.go.kr";
  const fieldText = pick(item, ["intrsThemaNmList", "지원분야"]);

  if (!isYouthRelevant(eligibilityText, parseEligibilityText(eligibilityText))) return null;

  return {
    id: `wf-${idPrefix}-${id}`,
    name,
    agency,
    category: toCategoryFromText(fieldText ?? name),
    summary: (benefit || target).slice(0, 80),
    benefit: benefit.slice(0, 200) || "지원 내용은 공고 원문 확인",
    rule: toRuleFragment(parseEligibilityText(eligibilityText), eligibilityText || name),
    apply: parseApplyWindow(period),
    checklist: splitChecklist(method, "복지로 또는 관할 행정복지센터에서 신청 방법 확인"),
    url,
    source: "welfare",
    updatedAt: today,
  };
}

export async function fetchWelfarePolicies(apiKey: string, signal?: AbortSignal): Promise<Policy[]> {
  const [centralRes, localRes] = await Promise.allSettled([
    fetchList(CENTRAL_ENDPOINT, apiKey, signal),
    fetchList(LOCAL_ENDPOINT, apiKey, signal),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const normalized: Policy[] = [];
  if (centralRes.status === "fulfilled") {
    for (const raw of centralRes.value) {
      const p = normalize(raw, "c", "보건복지부", today);
      if (p) normalized.push(p);
    }
  }
  if (localRes.status === "fulfilled") {
    for (const raw of localRes.value) {
      const p = normalize(raw, "l", "지방자치단체", today);
      if (p) normalized.push(p);
    }
  }
  if (centralRes.status === "rejected" && localRes.status === "rejected") {
    throw centralRes.reason;
  }
  return capList(normalized, 200);
}

export const welfareConnector: Connector = {
  id: "welfare",
  name: "복지로",
  requiredEnv: "DATA_GO_KR_API_KEY",
  fetchPolicies: fetchWelfarePolicies,
};
