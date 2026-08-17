import { INCOME_BANDS, type MatchResult, type Policy, type Profile, type Unknown, type Verdict } from "@/lib/types";
import { regionName } from "@/data/regions";

// 만 나이 계산 (월 단위 근사 — 일자까지는 프로필에서 받지 않는다)
export function koreanAge(birthYear: number, birthMonth: number, now: Date): number {
  let age = now.getFullYear() - birthYear;
  if (now.getMonth() + 1 < birthMonth) age -= 1;
  return age;
}

// 정책 규칙의 시도 코드용 지역명 — regionName의 미매칭 기본값("미입력")은
// "내가 입력을 안 했다"는 뜻이라 블로커 문구엔 어색하다. 규칙 쪽 코드가
// 매칭되지 않을 때는 "해당 지역"으로 표시한다.
function ruleRegionName(code: string): string {
  const name = regionName(code);
  return name === "미입력" ? "해당 지역" : name;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function ddayOf(policy: Policy, now: Date | null): { dday: number | null; closed: boolean } {
  if (now === null) return { dday: null, closed: false };
  if (policy.apply.kind !== "기간" || !policy.apply.end) return { dday: null, closed: false };
  const nowDay = startOfDay(now);
  const endTime = Date.parse(policy.apply.end + "T00:00:00");
  if (!Number.isFinite(endTime)) return { dday: null, closed: false }; // 방어적 가드 — normalize.ts가 이미 유효한 날짜만 apply.end로 넘기지만, 혹시 모를 손상값에 대비
  const endDay = startOfDay(new Date(endTime));
  const dday = Math.round((endDay.getTime() - nowDay.getTime()) / 86_400_000);
  if (!Number.isFinite(dday)) return { dday: null, closed: false };
  if (dday < 0) return { dday: null, closed: true };
  const started = !policy.apply.start || startOfDay(new Date(policy.apply.start + "T00:00:00")) <= nowDay;
  return { dday: started ? dday : null, closed: false };
}

// 연령 기준 라벨: 상·하한 조합에 맞춰 자연스러운 문구를 만든다.
function ageBoundsLabel(lo?: number, hi?: number): string {
  if (lo !== undefined && hi !== undefined) return lo === hi ? `${lo}세` : `${lo}~${hi}세`;
  if (hi !== undefined) return `${hi}세 이하`;
  if (lo !== undefined) return `${lo}세 이상`;
  return "";
}

export function matchPolicy(policy: Policy, profile: Profile, now: Date | null): MatchResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const unknowns: Unknown[] = [];
  const r = policy.rule;

  // 나이 — 코호트(당해 연도 N세) 규칙과 상·하한 규칙을 분리해서 판정한다.
  if (r.cohortAge !== undefined) {
    if (now === null || profile.birthYear === undefined) {
      unknowns.push({ field: "birthYear", label: "생년월" });
    } else {
      const isCohort = now.getFullYear() - profile.birthYear === r.cohortAge;
      if (isCohort) {
        reasons.push(`연령 충족 (올해 ${r.cohortAge}세, ${profile.birthYear}년생)`);
      } else {
        blockers.push(`당해 연도에 ${r.cohortAge}세가 되는 청년 대상`);
      }
    }
  } else if (r.minAge !== undefined || r.maxAge !== undefined) {
    if (now !== null && profile.birthYear !== undefined && profile.birthMonth === undefined) {
      unknowns.push({ field: "birthMonth", label: "출생 월" });
    } else if (now === null || profile.birthYear === undefined || profile.birthMonth === undefined) {
      unknowns.push({ field: "birthYear", label: "생년월" });
    } else {
      const age = koreanAge(profile.birthYear, profile.birthMonth, now);
      const boundsLabel = ageBoundsLabel(r.minAge, r.maxAge);
      const inRange = (r.minAge === undefined || age >= r.minAge) && (r.maxAge === undefined || age <= r.maxAge);
      if (inRange) {
        reasons.push(`연령 충족 (만 ${age}세, 기준 ${boundsLabel})`);
      } else {
        blockers.push(`연령 미충족 (만 ${age}세, 기준 ${boundsLabel})`);
      }
    }
  }

  // 지역
  if (r.sido && r.sido.length > 0) {
    if (!profile.sido) {
      unknowns.push({ field: "sido", label: "거주 지역" });
    } else if (r.sido.includes(profile.sido)) {
      reasons.push(`거주 지역 충족 (${regionName(profile.sido)})`);
    } else {
      blockers.push(`${r.sido.map(ruleRegionName).join("·")} 거주자 대상`);
    }
  }

  // 취업 상태
  if (r.employment && r.employment.length > 0) {
    if (!profile.employment) {
      unknowns.push({ field: "employment", label: "취업 상태" });
    } else if (r.employment.includes(profile.employment)) {
      reasons.push(`대상 상태 충족 (${profile.employment})`);
    } else {
      blockers.push(`${r.employment.join("·")} 대상 (현재: ${profile.employment})`);
    }
  }

  // 본인 연소득
  if (r.maxAnnualIncome !== undefined) {
    if (profile.annualIncome === undefined) {
      unknowns.push({ field: "annualIncome", label: "본인 연소득" });
    } else if (profile.annualIncome <= r.maxAnnualIncome) {
      reasons.push(`본인 소득 충족 (${r.maxAnnualIncome.toLocaleString()}만원 이하)`);
    } else {
      blockers.push(`본인 연소득 ${r.maxAnnualIncome.toLocaleString()}만원 이하 대상`);
    }
  }

  // 가구소득 (기준중위소득 %)
  if (r.maxHouseholdIncomePct !== undefined) {
    const band = INCOME_BANDS.find((b) => b.id === profile.householdIncome);
    if (!band || band.id === "unknown") {
      unknowns.push({ field: "householdIncome", label: "가구소득 구간" });
    } else if (band.max <= r.maxHouseholdIncomePct) {
      reasons.push(`가구소득 충족 (중위 ${r.maxHouseholdIncomePct}% 이하)`);
    } else if (band.min >= r.maxHouseholdIncomePct) {
      blockers.push(`가구소득 중위 ${r.maxHouseholdIncomePct}% 이하 대상`);
    } else {
      // 구간이 기준선에 걸침 → 정확한 소득 확인 필요
      unknowns.push({ field: "householdIncome", label: `정확한 가구소득 (기준선 ${r.maxHouseholdIncomePct}% 부근)` });
    }
  }

  // 혼인 / 주택
  if (r.unmarriedOnly) {
    if (profile.married === undefined) unknowns.push({ field: "married", label: "혼인 여부" });
    else if (profile.married) blockers.push("미혼 대상");
    else reasons.push("혼인 요건 충족 (미혼)");
  }
  if (r.noHouseOnly) {
    if (profile.hasHouse === undefined) unknowns.push({ field: "hasHouse", label: "주택 보유 여부" });
    else if (profile.hasHouse) blockers.push("무주택자 대상");
    else reasons.push("무주택 요건 충족");
  }

  // 외부 소스 텍스트에서 나이/지역을 하나도 확신 있게 파싱하지 못한 정책(rule.unverified) —
  // 걸린 조건이 하나도 없어 "eligible"로 흐르는 것을 막기 위해 판정을 needsInfo로 강등한다.
  // "interests"는 Profile에서 항상 채워져 있는 필드라 실제로 입력을 유도할 수 없는
  // non-focusable sentinel이다. missingFieldGains()에서 이 sentinel은 별도로 제외한다.
  if (r.unverified) {
    unknowns.push({ field: "interests", label: "세부 요건은 공고 원문 확인 필요" });
  }

  const { dday, closed } = ddayOf(policy, now);

  let verdict: Verdict;
  if (blockers.length > 0) verdict = "ineligible";
  else if (unknowns.length > 0) verdict = "needsInfo";
  else verdict = "eligible";

  // 점수: 판정 확실성 + 관심 분야 + 마감 임박 가중
  let score = verdict === "eligible" ? 100 : verdict === "needsInfo" ? 50 : 0;
  if (profile.interests.includes(policy.category)) score += 15;
  if (dday !== null && dday <= 30) score += 10;
  score -= unknowns.length * 5;

  return { policy, verdict, score, reasons, blockers, unknowns, dday, closed };
}

export function matchAll(policies: Policy[], profile: Profile, now: Date | null = null): MatchResult[] {
  const order: Record<Verdict, number> = { eligible: 0, needsInfo: 1, ineligible: 2 };
  return policies
    .map((p) => matchPolicy(p, profile, now))
    .sort((a, b) => {
      if (a.closed !== b.closed) return a.closed ? 1 : -1;
      if (order[a.verdict] !== order[b.verdict]) return order[a.verdict] - order[b.verdict];
      return b.score - a.score;
    });
}

// ── 챙길 요소 도출 ──────────────────────────────────────────

export interface FieldGain {
  field: keyof Profile;
  label: string;
  count: number; // 이 항목을 채우면 판정이 확정되는 정책 수
}

const FIELD_LABELS: Partial<Record<keyof Profile, string>> = {
  birthYear: "생년월",
  birthMonth: "출생 월",
  sido: "거주 지역",
  employment: "취업 상태",
  annualIncome: "본인 연소득",
  householdIncome: "가구소득 구간",
  married: "혼인 여부",
  hasHouse: "주택 보유 여부",
};

export function missingFieldGains(results: MatchResult[]): FieldGain[] {
  const counts = new Map<keyof Profile, number>();
  for (const r of results) {
    if (r.verdict !== "needsInfo" || r.closed) continue;
    for (const u of r.unknowns) {
      if (u.field === "interests") continue; // unverified 규칙용 non-focusable sentinel — 실제 결측 필드가 아니므로 챙길 것 목록에서 제외
      counts.set(u.field, (counts.get(u.field) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([field, count]) => ({ field, label: FIELD_LABELS[field] ?? String(field), count }))
    .sort((a, b) => b.count - a.count);
}

// 마감 임박 목록의 표시 순서 — 가장 급한 것(dday 작은 것)이 먼저, 같은 dday면 점수가
// 높은(더 확실히/더 관심분야에 맞는) 것이 먼저. matchAll()의 전체 정렬(판정→점수)과는
// 다른 기준이라 여기서 별도로 정렬한다 — 챙겨야 할 것 패널의 "N건 더 보기" 캡이 실제로
// 가장 급한 항목부터 보여줘야 의미가 있다.
export function closingSoon(results: MatchResult[], withinDays = 30): MatchResult[] {
  return results
    .filter((r) => !r.closed && r.dday !== null && r.dday <= withinDays && r.verdict !== "ineligible")
    .sort((a, b) => {
      const ddayDiff = (a.dday as number) - (b.dday as number);
      if (ddayDiff !== 0) return ddayDiff;
      return b.score - a.score;
    });
}
