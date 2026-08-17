import type { ApplyWindow, Category } from "@/lib/types";

// govbenefits/welfare/kstartup 커넥터가 공유하는 정규화 유틸.
// 소스마다 필드명은 다르지만 "카테고리 분류", "신청 방법 텍스트 → 체크리스트",
// "날짜 문자열 → ApplyWindow" 로직은 동일한 패턴이라 여기 모아둔다.

// 자유 텍스트(사업분야/서비스분야 등)에서 카테고리를 추론한다. 확신이 안 가면 복지·문화로 둔다.
export function toCategoryFromText(text?: string): Category {
  const t = text ?? "";
  if (/일자리|고용|취업|채용/.test(t)) return "일자리";
  if (/주거|주택|임대|전월세|월세/.test(t)) return "주거";
  if (/교육|장학|학자금/.test(t)) return "교육";
  if (/창업|스타트업|벤처/.test(t)) return "창업";
  if (/금융|자산|저축|대출|보증/.test(t)) return "금융·자산";
  return "복지·문화";
}

// 여러 후보 키 중 값이 있는 첫 필드를 반환 — 소스별 필드명 스펙이 불확실할 때 완충 역할.
export function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

// "신청방법" 류의 서술형 텍스트를 체크리스트 항목으로 분리한다.
// 번호(①②, 1., -) 나 줄바꿈으로 나뉘어 있으면 항목별로, 아니면 통째로 한 줄 사용.
export function splitChecklist(text: string | undefined, fallback: string, max = 4): string[] {
  if (!text) return [fallback];
  const parts = text
    .split(/\r?\n|[①②③④⑤]|(?:^|\s)\d\.\s|·/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const items = (parts.length > 1 ? parts : [text.trim()]).slice(0, max).map((s) => s.slice(0, 100));
  return items.length > 0 ? items : [fallback];
}

const YYYYMMDD_HYPHEN = /(\d{4}-\d{2}-\d{2})/g;
const YYYYMMDD_PLAIN = /(\d{8})/g;

// 마감을 뜻하는 단서와 시작을 뜻하는 단서 — 날짜가 하나만 발견됐을 때 그게 마감인지
// 시작인지를 텍스트의 문맥으로 구분한다. 둘 다 없으면 무엇도 확신할 수 없으므로 공고예정.
const DEADLINE_HINT_RE = /~|까지|마감|접수마감/;
const START_HINT_RE = /부터|시작|개시/;

function normalizeDatePiece(raw: string): string | undefined {
  const hyphen = raw.match(/^\d{4}-\d{2}-\d{2}$/);
  if (hyphen) return raw;
  const plain = raw.match(/^\d{8}$/);
  if (plain) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return undefined;
}

// "지원금 50000000원"처럼 8자리 숫자가 날짜가 아닌 다른 값(금액 등)에서 우연히 매칭되거나,
// "20260231"처럼 존재하지 않는 날짜가 만들어지는 경우를 걸러낸다. 실제 달력에 존재하는
// 날짜인지(Date.parse가 유효한 값을 내는지)와 연도가 상식적인 범위(2000~2100)인지를 함께 검사한다.
function isValidCalendarDate(d: string): boolean {
  const year = Number(d.slice(0, 4));
  if (!Number.isFinite(year) || year < 2000 || year > 2100) return false;
  const t = Date.parse(`${d}T00:00:00`);
  return Number.isFinite(t);
}

// "2026-01-01 ~ 2026-12-31", "20260101~20261231", "상시", 빈 문자열 등을 ApplyWindow로 변환.
// 날짜가 하나만 발견된 경우, 그 날짜를 곧바로 마감(end)으로 단정하지 않는다 — "접수
// 20260901부터"처럼 시작일만 적힌 문장을 마감으로 오인해 존재하지 않는 D-day를 만들어낼 수
// 있기 때문이다. 마감을 뜻하는 단서가 근처에 있을 때만 end로, 시작을 뜻하는 단서가 있으면
// start만 있는 기간으로, 둘 다 없으면 공고예정으로 처리한다.
export function parseApplyWindow(text: string | undefined): ApplyWindow {
  if (!text || /상시/.test(text)) return { kind: "상시" };
  const hyphenMatches = [...text.matchAll(YYYYMMDD_HYPHEN)].map((m) => m[1]);
  const plainMatches = hyphenMatches.length === 0 ? [...text.matchAll(YYYYMMDD_PLAIN)].map((m) => m[1]) : [];
  const raw = hyphenMatches.length > 0 ? hyphenMatches : plainMatches;
  const dates = raw.map(normalizeDatePiece).filter((d): d is string => d !== undefined).filter(isValidCalendarDate);

  if (dates.length >= 2) return { kind: "기간", start: dates[0], end: dates[1] };
  if (dates.length === 1) {
    if (DEADLINE_HINT_RE.test(text)) return { kind: "기간", end: dates[0] };
    if (START_HINT_RE.test(text)) return { kind: "기간", start: dates[0] };
    return { kind: "공고예정" };
  }
  return { kind: "공고예정" };
}

export function capList<T>(list: T[], max = 200): T[] {
  return list.slice(0, max);
}

// XML → 객체 변환 시 항목이 하나면 배열이 아니라 단일 객체로 오는 파서 특성을 흡수한다.
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// 명명 엔티티 — 소스가 값을 인코딩해 내려줄 때 흔히 쓰는 것만 다룬다.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// 숫자 참조(십진/16진) 중 CR/LF/TAB은 실제 개행/탭 문자를 살리지 않고 공백 하나로
// 접는다 — 요약문·체크리스트에 통제문자가 그대로 노출되는 것을 막기 위해서다.
const CONTROL_CODEPOINTS = new Set([0xd, 0xa, 0x9]);

function decodeEntitiesOnePass(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const num = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(num)) return match;
      if (CONTROL_CODEPOINTS.has(num)) return " ";
      try {
        return String.fromCodePoint(num);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : match;
  });
}

// 일부 소스가 값을 두 번 인코딩해서 내려준다(예: "&amp;#39;" → 한 번 풀면 "&#39;",
// 두 번째에 "'"). fast-xml-parser는 한 겹만 풀어주므로 여기서 최대 2회까지만 반복
// 디코딩한다 — 그 이상 반복하지 않는 이유는, 정상적으로 "&"가 그대로 들어있는 텍스트를
// 계속 파고들어 의도치 않게 다른 문자로 치환해버릴 위험을 피하기 위해서다.
// 마지막에 통제문자를 공백으로 접은 결과로 생긴 중복 공백도 하나로 모은다.
export function decodeEntities(s: string): string {
  let out = s;
  for (let pass = 0; pass < 2; pass++) {
    const next = decodeEntitiesOnePass(out);
    if (next === out) break;
    out = next;
  }
  return out.replace(/[ \t]{2,}/g, " ");
}

function textOf(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim().length > 0) return decodeEntities(v.trim());
  if (typeof v === "number") return String(v);
  return undefined;
}

// pick()은 Record<string, string>을 기대하지만 XML/JSON 파서는 값을 숫자 그대로 두는 경우가
// 있다(예: 서비스ID가 숫자로 옴) — pick()의 `typeof v === "string"` 검사에 걸려 그 필드가
// 통째로 무시되고 항목 자체가 드롭된다. 값을 얕게 문자열화해 이 문제를 없앤다.
// (textOf가 decodeEntities도 함께 적용하므로, 이 헬퍼를 거치는 모든 커넥터가 이중 인코딩
// 해제를 공유한다 — govbenefits/welfare가 여기 해당.)
export function stringifyRecord(item: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(item)) {
    const t = textOf(v);
    if (t !== undefined) out[k] = t;
  }
  return out;
}
