import type { Rule } from "@/lib/types";
import { REGIONS } from "@/data/regions";

// 자유 텍스트(지원대상/선정기준)에서 나이·지역 조건을 보수적으로 추출하는 공용 헬퍼.
// 여러 공공데이터 커넥터(govbenefits, welfare)가 공유한다.
//
// 원칙: 확신할 수 있는 패턴만 규칙으로 승격한다. 소득·취업 상태 등은 텍스트만으로는
// 기준치(만원, %, 재직/구직 여부 등)를 안전하게 특정할 수 없으므로 절대 생성하지 않고,
// 항상 note에 원문 요약을 남겨 "공고 원문 확인"을 유도한다.

export interface ParsedEligibility {
  minAge?: number;
  maxAge?: number;
  sido?: string[];
}

// "만 19세 ~ 34세", "19~34세", "만19세 이상 34세 이하" 같이 세가 뒤에 오는 range 표기.
// 첫 번째 숫자 뒤의 "세"는 선택(있어도/없어도 매칭) — "19~34세"처럼 뒤에만 붙는 경우가 흔함.
const RANGE_RE = /만?\s*(\d{1,2})\s*세?\s*(?:[~\-]|부터)\s*(?:만\s*)?(\d{1,2})\s*세/;
// "19세 이상 34세 이하"처럼 상·하한이 각각 "이상/이하"로 표현된 경우.
const BOTH_BOUNDS_RE = /만?\s*(\d{1,2})\s*세\s*이상[^0-9]{0,12}?(?:만\s*)?(\d{1,2})\s*세\s*이하/;
const GE_RE = /만?\s*(\d{1,2})\s*세\s*이상/;
const LE_RE = /만?\s*(\d{1,2})\s*세\s*이하/;
const LT_RE = /만?\s*(\d{1,2})\s*세\s*미만/;
const GT_RE = /만?\s*(\d{1,2})\s*세\s*초과/;

function isPlausibleAge(n: number): boolean {
  return Number.isFinite(n) && n > 0 && n <= 100;
}

// 나이 표현이 "신청인 본인"이 아니라 "돌봄 대상인 자녀/아동"을 가리키는 경우가 흔하다
// (예: "만 12세 이하 아동을 양육하는 청년" — 여기서 12세는 아이 나이고, 신청인 자격은
// 오히려 나이 제한이 없는 "청년"). 나이 표현 근처에 부양가족을 뜻하는 명사가 있으면 그
// 나이는 신청인 본인의 것이 아니라고 보고 후보에서 제외한다.
//
// 한국어 어순상 부양가족 명사가 나이 표현 "뒤"(예: "18세 미만 자녀")뿐 아니라 "앞"(예:
// "부양자녀 : 18세 미만", "아동(만 19세 미만)")에 오는 경우도 실제 데이터에서 매우 흔하다
// (근로·자녀장려금의 "부양자녀 : (18세 미만)", 진술조력인 지원의 "아동(만19세미만)").
// 기존엔 뒤쪽만 짧게(6자) 봐서 이런 "앞쪽" 어순을 전부 놓쳤다 — 앞(12자)·뒤(8자) 양쪽을
// 모두 봐야 한다.
const DEPENDENT_NOUNS = ["아동", "자녀", "영유아", "유아", "손자녀", "부양가족", "미성년"];
const DEPENDENT_NOUN_BEFORE_WINDOW = 12;
const DEPENDENT_NOUN_AFTER_WINDOW = 8;

// 신청인 본인을 가리키는 표현이 나이 표현 근처에 있으면, 그 나이 후보를 우선한다
// (여러 후보가 남았을 때의 동점 처리 기준).
const SELF_REFERENTIAL_KEYWORDS = ["본인", "신청인", "청년"];
const SELF_REFERENTIAL_WINDOW = 10;

// 신청인이 통상 속할 수 없는 나이대(너무 어리거나 너무 나이 많음)로 파싱된 밴드는
// 텍스트를 잘못 읽은 결과일 가능성이 높아 규칙으로 승격하지 않는다.
function isPlausibleApplicantBand(minAge?: number, maxAge?: number): boolean {
  if (maxAge !== undefined && maxAge < 15) return false;
  if (minAge !== undefined && minAge > 45) return false;
  return true;
}

function hasDependentNounNear(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - DEPENDENT_NOUN_BEFORE_WINDOW), start);
  const after = text.slice(end, end + DEPENDENT_NOUN_AFTER_WINDOW);
  return DEPENDENT_NOUNS.some((n) => before.includes(n) || after.includes(n));
}

function hasSelfReferentialNear(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - SELF_REFERENTIAL_WINDOW), start);
  const after = text.slice(end, end + SELF_REFERENTIAL_WINDOW);
  return SELF_REFERENTIAL_KEYWORDS.some((k) => before.includes(k) || after.includes(k));
}

// (짧은 창 밖의) 절(clause) 단위 안전망 — "정의: 아동(만 19세 미만)"처럼 부양가족 명사가
// 나이 표현과 같은 절에 있지만 앞뒤 창 밖에 떨어져 있는 경우까지 잡아낸다. ○ ㅇ □ ·
// 줄바꿈, 줄 앞의 "-" 글머리표, 문장종결(한글 뒤 마침표/느낌표/물음표)을 절 경계로 본다.
// "19-34"처럼 숫자 사이의 "-"는 글머리표가 아니므로 경계로 취급하지 않는다.
const CLAUSE_BOUNDARY_CHARS = ["○", "ㅇ", "□", "·"];

function isListDash(text: string, idx: number): boolean {
  if (text[idx] !== "-") return false;
  let i = idx - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  return i < 0 || text[i] === "\n";
}

function isSentenceEnderAt(text: string, idx: number): boolean {
  const ch = text[idx];
  if (ch !== "." && ch !== "!" && ch !== "?") return false;
  const prev = text[idx - 1];
  if (!prev || !/[가-힣]/.test(prev)) return false; // 날짜("5.1."), 소수 등 숫자 뒤 마침표는 제외
  const next = text[idx + 1];
  return next === undefined || /\s/.test(next);
}

function findClauseBoundaries(text: string): number[] {
  const positions = [0, text.length];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" || CLAUSE_BOUNDARY_CHARS.includes(ch)) positions.push(i);
    else if (isListDash(text, i)) positions.push(i);
    else if (isSentenceEnderAt(text, i)) positions.push(i + 1);
  }
  return positions.sort((a, b) => a - b);
}

function getClause(text: string, start: number, end: number, boundaries: number[]): string {
  let left = 0;
  let right = text.length;
  for (const b of boundaries) {
    if (b <= start && b > left) left = b;
    if (b >= end && b < right) right = b;
  }
  return text.slice(left, right);
}

// 절 전체에 부양가족 명사가 있고 신청인 본인을 가리키는 표현이 전혀 없으면, 그 절은
// "지원 특성상 신청자 아님이 명백"하다고 보고(예: 자녀/아동 정의 문구) 그 절 안의 나이
// 매치를 후보에서 제외한다. 같은 절에 본인을 가리키는 표현이 있으면(예: "청년 한부모") 그
// 절만으로는 판단하지 않고 기존의 창(window) 기준에 맡긴다.
function isDependentContextClause(clause: string): boolean {
  const hasDependentNoun = DEPENDENT_NOUNS.some((n) => clause.includes(n));
  if (!hasDependentNoun) return false;
  const hasSelfReferential = SELF_REFERENTIAL_KEYWORDS.some((k) => clause.includes(k));
  return !hasSelfReferential;
}

interface AgeCandidate {
  minAge?: number;
  maxAge?: number;
  start: number;
  end: number;
}

// text 안의 모든 매치를 훑어 후보를 만든다 — 부양가족 명사가 근처(앞/뒤 창)에 있거나 같은
// 절 안에서 명백히 부양가족을 정의하는 매치, 그리고 신청인 나이로 보기 힘든(implausible)
// 밴드는 애초에 후보에서 제외한다.
function collectCandidates(
  text: string,
  re: RegExp,
  toBand: (m: RegExpMatchArray) => { minAge?: number; maxAge?: number } | undefined,
  clauseBoundaries: number[],
): AgeCandidate[] {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const out: AgeCandidate[] = [];
  for (const m of text.matchAll(global)) {
    const band = toBand(m);
    if (!band) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (hasDependentNounNear(text, start, end)) continue;
    if (isDependentContextClause(getClause(text, start, end, clauseBoundaries))) continue;
    if (!isPlausibleApplicantBand(band.minAge, band.maxAge)) continue;
    out.push({ ...band, start, end });
  }
  return out;
}

// 유효한 후보가 여러 개 남으면 신청인 본인을 가리키는 표현이 근처에 있는 것을 우선하고,
// 없으면 텍스트에서 먼저 등장한 것을 쓴다.
function pickBest(candidates: AgeCandidate[], text: string): AgeCandidate | undefined {
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => a.start - b.start);
  const selfReferential = sorted.filter((c) => hasSelfReferentialNear(text, c.start, c.end));
  return (selfReferential.length > 0 ? selfReferential : sorted)[0];
}

function extractAgeRange(text: string): { minAge?: number; maxAge?: number } {
  const clauseBoundaries = findClauseBoundaries(text);

  // 완전한 범위 표현(상·하한이 한 매치에 함께 있는 경우)을 먼저 찾는다 — 개별 상한/하한
  // 표현보다 신뢰도가 높다.
  const completeCandidates = [
    ...collectCandidates(text, BOTH_BOUNDS_RE, (m) => {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (!isPlausibleAge(lo) || !isPlausibleAge(hi) || lo > hi) return undefined;
      return { minAge: lo, maxAge: hi };
    }, clauseBoundaries),
    ...collectCandidates(text, RANGE_RE, (m) => {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (!isPlausibleAge(lo) || !isPlausibleAge(hi) || lo > hi) return undefined;
      return { minAge: lo, maxAge: hi };
    }, clauseBoundaries),
  ];
  const bestComplete = pickBest(completeCandidates, text);
  if (bestComplete) return { minAge: bestComplete.minAge, maxAge: bestComplete.maxAge };

  // 완전한 범위 표현이 하나도 유효하지 않을 때만 개별 상한/하한 표현을 조합한다.
  const geCandidates = collectCandidates(text, GE_RE, (m) => {
    const v = Number(m[1]);
    return isPlausibleAge(v) ? { minAge: v } : undefined;
  }, clauseBoundaries);
  const leCandidates = collectCandidates(text, LE_RE, (m) => {
    const v = Number(m[1]);
    return isPlausibleAge(v) ? { maxAge: v } : undefined;
  }, clauseBoundaries);

  let minAge = pickBest(geCandidates, text)?.minAge;
  let maxAge = pickBest(leCandidates, text)?.maxAge;

  if (maxAge === undefined) {
    // "미만" = 초과 배제, 상한을 하나 내려서 반영
    const ltCandidates = collectCandidates(text, LT_RE, (m) => {
      const v = Number(m[1]);
      return v > 1 && v <= 100 ? { maxAge: v - 1 } : undefined;
    }, clauseBoundaries);
    maxAge = pickBest(ltCandidates, text)?.maxAge;
  }
  if (minAge === undefined) {
    // "초과" = 하한을 하나 올려서 반영
    const gtCandidates = collectCandidates(text, GT_RE, (m) => {
      const v = Number(m[1]);
      return v > 0 && v < 100 ? { minAge: v + 1 } : undefined;
    }, clauseBoundaries);
    minAge = pickBest(gtCandidates, text)?.minAge;
  }
  return { minAge, maxAge };
}

// 지역명은 오탐을 피하기 위해 정식 명칭(예: "서울특별시", "경기도")만 매칭한다.
// "전국"이 명시된 경우는 지역 제한이 없다는 뜻이므로 코드를 세팅하지 않는다.
function extractSido(text: string): string[] | undefined {
  if (text.includes("전국")) return undefined;
  const codes = new Set<string>();
  for (const region of REGIONS) {
    if (text.includes(region.name)) codes.add(region.code);
  }
  return codes.size > 0 ? [...codes] : undefined;
}

export function parseEligibilityText(text: string): ParsedEligibility {
  if (!text) return {};
  const { minAge, maxAge } = extractAgeRange(text);
  const sido = extractSido(text);
  return { minAge, maxAge, sido };
}

// 텍스트만으로 판정할 수 없는 나머지 요건(소득·취업 상태 등)은 규칙으로 옮기지 않고
// 원문 요약을 note에 남긴다. 나이/지역이 파싱됐어도 다른 요건이 숨어 있을 수 있으므로 항상 붙인다.
export function buildEligibilityNote(text: string, maxLen = 70): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const excerpt = trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
  return excerpt ? `${excerpt} — 세부 요건은 공고 원문 확인` : "세부 요건은 공고 원문 확인";
}

// 나이도 지역도 확신 있게 파싱되지 않으면 이 규칙만으로는 아무 조건도 걸리지 않는다 —
// 그 상태로 판정을 진행하면 "충족 조건 없음 → eligible"이 되어 근거 없이 "지금 신청
// 가능"에 오르게 된다. 이런 경우 unverified 플래그를 세워 match.ts가 needsInfo로
// 강등하도록 한다(공고 원문 확인이 필요하다는 뜻).
export function toRuleFragment(parsed: ParsedEligibility, noteText: string): Rule {
  const parsedConfidently =
    parsed.minAge !== undefined || parsed.maxAge !== undefined || (parsed.sido !== undefined && parsed.sido.length > 0);
  const rule: Rule = {
    minAge: parsed.minAge,
    maxAge: parsed.maxAge,
    sido: parsed.sido,
    note: buildEligibilityNote(noteText),
  };
  if (!parsedConfidently) rule.unverified = true;
  return rule;
}

const YOUTH_KEYWORDS = ["청년", "청소년", "대학생", "취업준비", "구직청년", "사회초년생"];
const ALL_AGES_KEYWORDS = ["누구나", "전 국민"];

// 청년 관련성 필터 — govbenefits/welfare는 전 연령대를 다루므로 청년과 무관한 항목을
// 걸러낸다. 빈/공백 텍스트는 근거가 전혀 없으므로 통과시키지 않는다(필드명이 틀린 소스가
// 텍스트를 못 채운 채로 수백 건을 "청년 관련"으로 흘려보내는 것을 막는다). 키워드 언급,
// 명시적 전 연령 대상 표현, 또는 파싱된 연령대가 15~39와 겹치는 경우만 통과시킨다.
// 연령을 전혀 파싱하지 못한 텍스트는 더 이상 "제한 없음"으로 간주해 자동 통과시키지 않는다.
export function isYouthRelevant(text: string, parsed: ParsedEligibility): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (YOUTH_KEYWORDS.some((k) => trimmed.includes(k))) return true;
  if (ALL_AGES_KEYWORDS.some((k) => trimmed.includes(k))) return true;
  const { minAge, maxAge } = parsed;
  if (minAge === undefined && maxAge === undefined) return false; // 연령 파싱 실패 — 근거 없이 통과시키지 않는다
  const lo = minAge ?? 0;
  const hi = maxAge ?? 200;
  return lo <= 39 && hi >= 15; // 15~39세 구간과 겹치는지
}
