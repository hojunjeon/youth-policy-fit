// 정책 매칭 도메인 타입.
// 프로필은 경험 DB의 "인적 사항" 축이 되는 데이터로, 이후 자소서 기능에서도 재사용한다.

export type EmploymentStatus = "재직" | "구직" | "창업" | "재학" | "졸업유예" | "기타";

export type IncomeBandId = "b60" | "b100" | "b150" | "b250" | "over" | "unknown";

export interface IncomeBand {
  id: IncomeBandId;
  label: string;
  min: number; // 기준중위소득 % 하한
  max: number; // 상한
}

export const INCOME_BANDS: IncomeBand[] = [
  { id: "b60", label: "중위소득 60% 이하", min: 0, max: 60 },
  { id: "b100", label: "60 ~ 100%", min: 60, max: 100 },
  { id: "b150", label: "100 ~ 150%", min: 100, max: 150 },
  { id: "b250", label: "150 ~ 250%", min: 150, max: 250 },
  { id: "over", label: "250% 초과", min: 250, max: 10000 },
  { id: "unknown", label: "잘 모름", min: 0, max: 10000 },
];

export type Category = "일자리" | "주거" | "금융·자산" | "교육" | "복지·문화" | "창업";

export const CATEGORIES: Category[] = ["일자리", "주거", "금융·자산", "교육", "복지·문화", "창업"];

export interface Profile {
  birthYear?: number;
  birthMonth?: number;
  sido?: string; // 법정코드 상위 2자리, "00" = 해외/기타
  employment?: EmploymentStatus;
  annualIncome?: number; // 본인 연소득, 만원. undefined = 미입력
  householdIncome?: IncomeBandId;
  married?: boolean;
  hasHouse?: boolean; // 본인 명의 주택 보유
  interests: Category[];
  updatedAt?: string; // ISO 타임스탬프 — 로컬/서버 병합 시 최신 판정 기준 (last-write-wins)
}

export const EMPTY_PROFILE: Profile = { interests: [] };

export interface Rule {
  minAge?: number;
  maxAge?: number;
  cohortAge?: number; // "당해 연도에 N세가 되는 사람" — 생년(월 무관)만으로 판정
  sido?: string[]; // 미지정 = 전국
  employment?: EmploymentStatus[]; // 미지정 = 무관
  maxAnnualIncome?: number; // 본인 연소득 상한, 만원
  maxHouseholdIncomePct?: number; // 가구 기준중위소득 % 상한
  unmarriedOnly?: boolean;
  noHouseOnly?: boolean; // 무주택 요건
  unverified?: boolean; // 외부 소스 자유 텍스트에서 요건을 파싱하지 못함 — 판정은 "확인 필요"로 강등
  note?: string; // 프로필로 판정할 수 없는 세부 요건
}

export interface ApplyWindow {
  kind: "상시" | "기간" | "공고예정";
  start?: string; // YYYY-MM-DD
  end?: string;
  estimated?: boolean; // 예년 일정 기반 추정치
  cycle?: string; // "매월", "연 1회(상반기)" 등
}

export interface Policy {
  id: string;
  name: string;
  agency: string; // 주관 기관
  category: Category;
  summary: string; // 한 줄 요약
  benefit: string; // 지원 내용
  rule: Rule;
  apply: ApplyWindow;
  checklist: string[]; // 신청 전 챙길 것
  url: string;
  source: "seed" | "youthcenter" | "govbenefits" | "welfare" | "kstartup";
  updatedAt: string; // 데이터 기준일
}

export type Verdict = "eligible" | "needsInfo" | "ineligible";

export interface Unknown {
  field: keyof Profile;
  label: string;
}

export interface MatchResult {
  policy: Policy;
  verdict: Verdict;
  score: number;
  reasons: string[]; // 충족한 조건
  blockers: string[]; // 미달 사유
  unknowns: Unknown[]; // 입력하면 판정이 확정되는 항목
  dday: number | null; // 마감까지 남은 일수 (상시 = null)
  closed: boolean; // 접수 기간 종료
}
