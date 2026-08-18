import { XMLParser } from "fast-xml-parser";
import type { Connector } from "@/lib/sources/types";
import type { Policy, Rule } from "@/lib/types";
import { toCategoryFromText, pick, splitChecklist, capList, asArray, stringifyRecord } from "@/lib/sources/normalize";
import { REGIONS } from "@/data/regions";

// 복지로(한국사회보장정보원) 중앙부처/지자체 복지서비스 API.
//   중앙부처: data.go.kr/data/15090532
//   지자체:   data.go.kr/data/15108347
// 둘 다 서비스명 "한국사회보장정보원_○○복지서비스", XML 응답, 서비스키는 공공데이터포털
// 공용 키(DATA_GO_KR_API_KEY)를 그대로 쓴다.
//
// ── 실 키로 재검증한 기록 (2026-08-17, Node 스크립트로 직접 호출) ──────────────
//
// [central] GET .../NationalWelfarelistV001
//   - serviceKey만으로는 400계열 에러(resultCode 10 INVALID_REQUEST_PARAMETER_ERROR)가 난다.
//     반드시 callTp=L & srchKeyCode=003 를 함께 보내야 한다(다른 값 조합은 시도하지 않음 —
//     이 조합이 SUCCESS를 내는 것만 확인). 이 둘이 빠지면 항상 실패한다.
//   - callTp=L&srchKeyCode=003만 보내면 totalCount=461, resultCode 0 SUCCESS.
//   - lifeArray 파라미터가 서버에서 실제로 필터링된다(값을 바꿔가며 totalCount 변화로 확인):
//       001=영유아(69) 002=아동(97) 003=청소년(117) 004=청년(165) 005=중장년(140)
//       006=노년(143) 007=임신·출산(39) 008=NO DATA FOUND(존재하지 않는 코드)
//     → 애초 추정했던 "006=청년"은 틀렸고 실제로는 004=청년. lifeArray=004로 필터링된
//     165건 전부의 <lifeArray> 값에 "청년"이 포함됨을 직접 확인했다(무작위 다건 샘플).
//   - trgterIndvdlArray(대상개인 특성 코드, 예: 013)는 시도한 값 전부 NO DATA FOUND(resultCode 40)만
//     반환해 사용하지 않았다.
//   - 목록 응답 필드(실제로 나온 것만): inqNum, intrsThemaArray(관심주제 CSV), jurMnofNm(소관부처),
//     jurOrgNm(소관과), lifeArray(생애주기 CSV), onapPsbltYn, rprsCtadr(대표전화), servDgst(한 줄 요약),
//     servDtlLink(복지로 상세 URL), servId, servNm, sprtCycNm(지원주기), srvPvsnNm(제공방식),
//     svcfrstRegTs(최초등록일), trgterIndvdlArray(대상특성 CSV, 종종 없음).
//     "지원대상"/"선정기준"/"신청방법"에 해당하는 필드는 목록 응답에 전혀 없다 — 상세조회
//     (NationalWelfaredetailedV001)에만 있는데, 항목마다 별도 호출이 필요해 캡·타임아웃
//     예산 안에서 비효율적이라 호출하지 않는다.
//
// [local] GET .../LcgvWelfarelist
//   - serviceKey + pageNo + numOfRows 만으로 SUCCESS(totalCount=4778) — callTp/srchKeyCode 불필요.
//   - lifeArray 파라미터도 central과 같은 코드 체계로 동작한다(직접 재확인):
//       001=897 002=859 003=938 004=청년(1246) 005=944 006=노년(1332) 007=467 008=0
//     lifeArray=004로 필터링된 1246건의 <lifeNmArray> 값 전부에 "청년" 포함을 확인했다.
//   - 목록 응답 필드(실제로 나온 것만): aplyMtdNm(신청방법: "방문"/"인터넷, 방문" 같은 짧은 채널명),
//     bizChrDeptNm(담당부서 전체경로, 예: "전남광주통합특별시 강진군 복지환경국 군민행복과"),
//     ctpvNm(시도명), inqNum, intrsThemaNmArray(관심주제, 종종 없음), lastModYmd(최종수정일),
//     lifeNmArray(생애주기, 종종 없음), servDgst, servDtlLink, servId, servNm, sggNm(시군구명),
//     sprtCycNm, srvPvsnNm, trgterIndvdlNmArray(대상특성, 종종 없음).
//   - ctpvNm은 대부분 REGIONS(src/data/regions.ts)의 정식 명칭과 정확히 일치한다(직접 대조:
//     서울특별시/경기도/강원특별자치도/인천광역시/경상남도/경상북도/대구광역시/대전광역시/
//     부산광역시/울산광역시/전북특별자치도/제주특별자치도/충청남도/충청북도 — 모두 그대로 일치).
//     "전남광주통합특별시"도 실제로 존재하는 표기다 — 2026-08-17 온통청년 getPlcy API 재검증에서
//     법정 시도코드 체계가 12=전남광주통합특별시(광주광역시 29 + 전라남도 46의 2026년 통합)로
//     바뀐 것을 zipCd 접두 실측(11,12,26,27,28,30,31,36,41,43,44,47,48,50,51,52 — 29·46은
//     한 번도 안 나옴)으로 확인했다. REGIONS도 이제 광주(29)·전남(46) 대신 12 하나만 갖고
//     있으므로 이 표기는 SIDO_NAME_OVERRIDES에서 ["12"] 하나로 매핑한다(REGIONS 조회만으로도
//     사실 커버되지만 의도를 명시하기 위해 남겨둠). 세종특별자치시는 샘플(2,400여 건)에 한 번도
//     나오지 않아 실존 여부를 확인하지 못했지만, REGIONS 정식명 그대로 매칭되므로 나오면 자동 처리된다.
//
// [필터링 방식] 목록 응답엔 지원대상/선정기준 자유 텍스트가 전혀 없어 parseEligibility.ts의
// isYouthRelevant()에 넘길 텍스트 자체가 없다(빈 문자열을 넘기면 그 함수는 근거 없음으로 보고
// 항상 false를 반환해 전건이 드롭된다 — 실제로 개편 전 버전이 그렇게 항상 0건을 반환했던
// 원인이다). 서버가 lifeArray=004로 "청년"을 이미 정확히 필터링해주므로 클라이언트 텍스트
// 필터링은 쓰지 않고 서버 필터를 그대로 신뢰한다.
//
// [자격 요건] 나이/소득 등 세부 요건을 판정할 텍스트가 없으므로 규칙은 항상 unverified로 두고
// (match.ts가 needsInfo로 강등해 "공고 원문 확인"을 유도), ctpvNm이 매핑되는 지자체 항목만
// rule.sido를 채워 지역 필터링이 동작하게 한다.
const CENTRAL_ENDPOINT = "https://apis.data.go.kr/B554287/NationalWelfareInformationsV001/NationalWelfarelistV001";
const LOCAL_ENDPOINT = "https://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist";
const YOUTH_LIFE_ARRAY_CODE = "004"; // 생애주기 코드 — 위 주석대로 004 = 청년(central/local 공통 확인)
const NUM_OF_ROWS = "50";

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

interface RawItem {
  [key: string]: unknown;
}

// REGIONS는 이제 "전남광주통합특별시"를 코드 12로 정식 등재하고 있어 아래 첫 항목은
// REGIONS 조회만으로도 사실 커버되지만, 명시적으로 남겨 의도를 분명히 한다. 옛 개별 표기
// "광주광역시"/"전라남도"는 REGIONS에서 빠졌으므로(2026 통합으로 12 하나로 대체) 그 이름
// 그대로 응답이 올 경우를 대비해 방어적으로 12로 매핑해둔다.
const SIDO_NAME_OVERRIDES: Record<string, string[]> = {
  전남광주통합특별시: ["12"],
  광주광역시: ["12"], // 통합 이전 표기 잔존 대비 (방어적)
  전라남도: ["12"], // 통합 이전 표기 잔존 대비 (방어적)
};

function sidoCodesFromCtpvNm(ctpvNm: string | undefined): string[] | undefined {
  if (!ctpvNm) return undefined;
  const overridden = SIDO_NAME_OVERRIDES[ctpvNm];
  if (overridden) return overridden;
  const region = REGIONS.find((r) => r.name === ctpvNm);
  return region ? [region.code] : undefined;
}

// buildEligibilityNote(parseEligibility.ts)는 접미사가 "공고 원문 확인"으로 고정돼 있어
// 이 소스엔 맞지 않는다(목록 응답이 항상 복지로 상세 링크를 갖고 있으므로 "복지로 상세에서
// 확인"이 더 정확한 안내다) — 같은 트림/말줄임 로직을 이 파일 안에서 짧게 재현한다.
function buildWelfareNote(summary: string, maxLen = 70): string {
  const trimmed = summary.replace(/\s+/g, " ").trim();
  const excerpt = trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
  return excerpt ? `${excerpt} — 지원대상은 복지로 상세에서 확인` : "지원대상은 복지로 상세에서 확인";
}

// 목록 응답엔 지원대상/선정기준 텍스트가 없어 나이 등 세부 요건을 절대 확신 있게 파싱할 수
// 없다 — 그래서 항상 unverified=true. sido만은 ctpvNm이라는 구조화된 필드에서 나온 확실한
// 값이라 별도로 채운다(unverified와는 독립적으로 지역 필터링이 동작해야 하므로).
function buildRule(summary: string, sido?: string[]): Rule {
  return { unverified: true, sido, note: buildWelfareNote(summary) };
}

async function fetchList(
  endpoint: string,
  apiKey: string,
  extraParams: Record<string, string>,
  signal?: AbortSignal,
): Promise<RawItem[]> {
  const params = new URLSearchParams({
    serviceKey: apiKey,
    pageNo: "1",
    numOfRows: NUM_OF_ROWS,
    lifeArray: YOUTH_LIFE_ARRAY_CODE,
    ...extraParams,
  });
  const res = await fetch(`${endpoint}?${params}`, { next: { revalidate: 3600 }, signal });
  if (!res.ok) throw new Error(`welfare API ${res.status} (${endpoint})`);
  const xml = await res.text();
  const json = parser.parse(xml);
  const wanted = json?.wantedList;
  const resultCode = wanted?.resultCode;
  // resultCode "0" = SUCCESS. 그 외(예: "10" INVALID_REQUEST_PARAMETER_ERROR, "40" NO DATA FOUND)는
  // HTTP 200으로 오므로 상태 코드만으로는 못 걸러낸다 — 본문의 resultCode를 직접 봐야 한다.
  // "40"(NO DATA FOUND)은 에러가 아니라 그냥 빈 결과이므로 조용히 빈 배열을 반환한다.
  if (resultCode !== undefined && String(resultCode) !== "0" && String(resultCode) !== "40") {
    throw new Error(`welfare API resultCode ${resultCode} ${wanted?.resultMessage ?? ""} (${endpoint})`);
  }
  return asArray(wanted?.servList ?? []);
}

function normalizeCentral(raw: RawItem, today: string): Policy | null {
  const item = stringifyRecord(raw);
  const id = pick(item, ["servId"]);
  const name = pick(item, ["servNm"]);
  if (!id || !name) return null;

  const summary = pick(item, ["servDgst"]) ?? "";
  const agency = pick(item, ["jurMnofNm"]) ?? "중앙부처";
  const url = pick(item, ["servDtlLink"]) ?? "https://www.bokjiro.go.kr";
  const themeText = pick(item, ["intrsThemaArray"]);

  return {
    id: `wf-c-${id}`,
    name,
    agency,
    category: toCategoryFromText(themeText ?? summary ?? name),
    summary: summary.slice(0, 80) || name,
    benefit: summary.slice(0, 200) || "지원 내용은 복지로 상세에서 확인",
    rule: buildRule(summary || name),
    apply: { kind: "상시" }, // 목록 응답엔 신청기간 필드가 없다(sprtCycNm은 지원주기일 뿐 접수기간이 아님)
    checklist: splitChecklist(undefined, "복지로 또는 관할 행정복지센터에서 신청 방법 확인"),
    url,
    source: "welfare",
    updatedAt: today,
  };
}

function normalizeLocal(raw: RawItem, today: string): Policy | null {
  const item = stringifyRecord(raw);
  const id = pick(item, ["servId"]);
  const name = pick(item, ["servNm"]);
  if (!id || !name) return null;

  const summary = pick(item, ["servDgst"]) ?? "";
  const agency = pick(item, ["bizChrDeptNm"]) ?? "지방자치단체";
  const url = pick(item, ["servDtlLink"]) ?? "https://www.bokjiro.go.kr";
  const themeText = pick(item, ["intrsThemaNmArray"]);
  const method = pick(item, ["aplyMtdNm"]);
  const ctpvNm = pick(item, ["ctpvNm"]);

  return {
    id: `wf-l-${id}`,
    name,
    agency,
    category: toCategoryFromText(themeText ?? summary ?? name),
    summary: summary.slice(0, 80) || name,
    benefit: summary.slice(0, 200) || "지원 내용은 복지로 상세에서 확인",
    rule: buildRule(summary || name, sidoCodesFromCtpvNm(ctpvNm)),
    apply: { kind: "상시" }, // 목록 응답엔 신청기간 필드가 없다
    checklist: splitChecklist(method, "복지로 또는 관할 행정복지센터에서 신청 방법 확인"),
    url,
    source: "welfare",
    updatedAt: today,
  };
}

export async function fetchWelfarePolicies(apiKey: string, signal?: AbortSignal): Promise<Policy[]> {
  const [centralRes, localRes] = await Promise.allSettled([
    fetchList(CENTRAL_ENDPOINT, apiKey, { callTp: "L", srchKeyCode: "003" }, signal),
    fetchList(LOCAL_ENDPOINT, apiKey, {}, signal),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const normalized: Policy[] = [];
  if (centralRes.status === "fulfilled") {
    for (const raw of centralRes.value) {
      const p = normalizeCentral(raw, today);
      if (p) normalized.push(p);
    }
  }
  if (localRes.status === "fulfilled") {
    for (const raw of localRes.value) {
      const p = normalizeLocal(raw, today);
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
