import { XMLParser } from "fast-xml-parser";
import type { Connector } from "@/lib/sources/types";
import type { ApplyWindow, Policy } from "@/lib/types";
import { parseEligibilityText, toRuleFragment, isYouthRelevant } from "@/lib/sources/parseEligibility";
import { asArray, capList, decodeEntities } from "@/lib/sources/normalize";

// K-스타트업 창업지원공고 API (data.go.kr/data/15125364).
//
// 엔드포인트 검증: 2026-08-17, curl로 실제 호출해 확인 — 실 데이터가 그대로 반환됐다.
//   curl "https://nidapi.k-startup.go.kr/api/kisedKstartupService/v1/getAnnouncementInformation?page=1&perPage=1"
//   → HTTP 200, <results><currentCount>1</currentCount><data><item><col name="biz_pbanc_nm">...</col>...
// 이 엔드포인트는 (테스트 시점 기준) serviceKey 없이도 응답한다. 다만 공공데이터포털 문서상
// 정식 활용신청 키가 요구될 수 있어 requiredEnv는 공용 DATA_GO_KR_API_KEY로 두고, 있으면
// serviceKey 파라미터로 함께 보낸다 — 키가 없어도 이 커넥터는 시도하되, registry에서는
// 다른 data.go.kr 커넥터와 동일하게 "키 있음"을 전제로 노출한다.
// 응답은 `<col name="필드명">값</col>` 형태의 XML이며, resultType=json 파라미터를 붙여도
// 무시되고 항상 XML로 온다(실측 확인). 필드명은 실제 응답에서 그대로 확인된 것이다.
const ENDPOINT = "https://nidapi.k-startup.go.kr/api/kisedKstartupService/v1/getAnnouncementInformation";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true });

interface ColRaw {
  "@_name"?: string;
  "#text"?: string | number;
}

function colsToRecord(cols: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const col of asArray<ColRaw>(cols as ColRaw | ColRaw[] | undefined)) {
    const name = col?.["@_name"];
    if (!name) continue;
    const text = col?.["#text"];
    // fast-xml-parser는 한 겹만 언이스케이프한다 — 이 API가 값을 이중 인코딩해서 내려주는
    // 경우(&apos; &#39; &#xD; 등)가 있어 여기서 다시 decodeEntities로 정리한다.
    out[name] = text === undefined ? "" : decodeEntities(String(text));
  }
  return out;
}

function parseYmd(s?: string): string | undefined {
  if (!s) return undefined;
  const d = s.replace(/[^0-9]/g, "");
  if (d.length !== 8) return undefined;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function buildApplyWindow(startRaw?: string, endRaw?: string): ApplyWindow {
  const start = parseYmd(startRaw);
  const end = parseYmd(endRaw);
  if (end) return { kind: "기간", start, end };
  return { kind: "공고예정" };
}

// 이 API는 "창업지원사업 공고"뿐 아니라 행사성 항목(워크숍, 밋업, 설명회, 입주기업 모집,
// 네트워킹 등)도 같은 목록에 섞여 나온다 — 청년 개인이 "신청 가능한 지원사업"으로 오인하면
// 안 되는 항목들이라 제목 기준으로 걸러낸다. "공모전"은 지원금이 걸린 공모(자금 지원)도
// 섞여 있어 예외로 남겨둔다(제외 목록에서 뺌).
const EXCLUDE_TITLE_RE =
  /교육|세미나|워크숍|워크샵|밋업|설명회|컨설팅|입주\s?기업|1인\s?창조기업|창조기업|입주자\s?모집|입주\s?모집|페스타|캠프|해커톤|데모데이|네트워킹|경진대회|IR |오픈이노베이션/;

// 접수 방법 필드(이메일/온라인/팩스/방문/우편/기타)는 채워진 것만 모아 체크리스트로 만든다.
function buildChecklist(item: Record<string, string>): string[] {
  const methods: Array<[string, string | undefined]> = [
    ["온라인 접수", item.aply_mthd_onli_rcpt_istc],
    ["이메일 접수", item.aply_mthd_eml_rcpt_istc],
    ["방문 접수", item.aply_mthd_vst_rcpt_istc],
    ["우편 접수", item.aply_mthd_pssr_rcpt_istc],
    ["팩스 접수", item.aply_mthd_fax_rcpt_istc],
    ["기타 접수", item.aply_mthd_etc_istc],
  ];
  const list = methods.filter(([, v]) => v && v.trim().length > 0).map(([label, v]) => `${label}: ${v!.trim()}`.slice(0, 100));
  return list.length > 0 ? list : ["K-스타트업 공고 원문에서 신청 방법 확인"];
}

function normalize(raw: ColRaw[] | Record<string, string>, today: string): Policy | null {
  const item = Array.isArray(raw) ? colsToRecord(raw) : raw;
  const id = item.pbanc_sn || item.id;
  const name = (item.biz_pbanc_nm || item.intg_pbanc_biz_nm || "").trim();
  if (!id || !name) return null;
  if (EXCLUDE_TITLE_RE.test(name)) return null; // 행사/교육/입주기업 모집 등 — 지원사업 공고가 아님

  const eligibilityText = item.aply_trgt_ctnt || item.aply_trgt || "";
  // govbenefits/welfare와 동일한 청년 관련성 필터 — 이게 없으면 청년과 무관한 대상(예:
  // 재직 중인 특정 업종 대표자, 전 연령 대상 시설 모집 등)까지 "지금 신청 가능"에 오른다.
  if (!isYouthRelevant(eligibilityText, parseEligibilityText(eligibilityText))) return null;

  const agency = item.pbanc_ntrp_nm || "중소벤처기업부 · 창업진흥원";
  const summary = (item.pbanc_ctnt || "").replace(/\s+/g, " ").trim();

  return {
    id: `ks-${id}`,
    name,
    agency,
    category: "창업",
    summary: summary.slice(0, 80) || "K-스타트업 창업지원 공고",
    benefit: summary.slice(0, 200) || "지원 내용은 공고 원문 확인",
    rule: toRuleFragment(parseEligibilityText(eligibilityText), eligibilityText || name),
    apply: buildApplyWindow(item.pbanc_rcpt_bgng_dt, item.pbanc_rcpt_end_dt),
    checklist: buildChecklist(item),
    url: item.detl_pg_url || "https://www.k-startup.go.kr",
    source: "kstartup",
    updatedAt: today,
  };
}

export async function fetchKstartupPolicies(apiKey: string, signal?: AbortSignal): Promise<Policy[]> {
  // 200 → 50: 청년 관련성/제목 필터를 통과하는 항목이 실제로는 적은데도 200건씩 끌어와
  // 필터링에 의존하는 것보다, 요청 단계에서 페이지 크기를 줄여 최신 공고 위주로 받는다
  // (registry의 200건 캡은 안전망으로 유지).
  const params = new URLSearchParams({ page: "1", perPage: "50" });
  if (apiKey) params.set("serviceKey", apiKey);
  const res = await fetch(`${ENDPOINT}?${params}`, { next: { revalidate: 3600 }, signal });
  if (!res.ok) throw new Error(`kstartup API ${res.status}`);
  const xml = await res.text();
  const json = parser.parse(xml);
  const items = asArray<{ col?: ColRaw | ColRaw[] }>(json?.results?.data?.item);
  const today = new Date().toISOString().slice(0, 10);
  const normalized = items
    .map((it) => normalize(asArray<ColRaw>(it?.col), today))
    .filter((p): p is Policy => p !== null);
  return capList(normalized, 200);
}

// 이 엔드포인트는 실측상 serviceKey 없이도 200을 반환한다(위 주석 참고). requiredEnv로
// 두면 기본(무키) 설치에서 이 커넥터까지 꺼져 실 데이터 소스가 하나도 안 뜨는 문제가
// 생기므로, optionalEnv로 등록해 키가 없어도 항상 시도하고 있으면 함께 실어 보낸다.
export const kstartupConnector: Connector = {
  id: "kstartup",
  name: "K-스타트업",
  optionalEnv: "DATA_GO_KR_API_KEY",
  fetchPolicies: fetchKstartupPolicies,
};
