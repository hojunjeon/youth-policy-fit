import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { CATEGORIES, INCOME_BANDS, type Category, type IncomeBandId, type Profile } from "@/lib/types";

// 이 앱은 로컬 컴퓨터에서 혼자 쓰는 단일 사용자 앱이다 — 별도 인증 없이 프로필을
// 그대로 읽고 쓴다. 여러 사용자가 공유하는 서버로 옮긴다면 이 지점에 인증을 추가해야 한다.
export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "profile.json");
const MAX_BODY_BYTES = 10 * 1024;

// 요청마다 고유한 임시 파일 경로를 만든다 — 고정된 이름(profile.json.tmp) 하나를 여러
// 동시 요청이 공유하면, 한 요청이 쓰는 도중 다른 요청이 같은 파일에 덮어써서 rename 시점에
// 서로 다른 요청의 내용이 섞이거나(둘 다 실패는 아니지만 하나가 유실) ENOENT로 500이 나는
// 레이스가 생긴다(동시 PUT에서 실측). pid + 고해상도 타임스탬프 + 랜덤 접미사로 요청 간
// 충돌 가능성을 없앤다.
function makeTmpFilePath(): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(DATA_DIR, `profile.json.${unique}.tmp`);
}

// 위 tmp 파일 레이스와 별개로, "저장된 값을 읽고 → 검증하고 → 쓰는" 판단(finding 5의 409
// 규칙) 자체가 두 요청 사이에 끼어들면 안 되는 임계구역이다 — 동시에 들어온 두 PUT이 서로
// 다른 stored 스냅샷을 보고 각자 통과 판정을 내리면 규칙이 무의미해진다. 그래서 모든 쓰기를
// 이 모듈 전역 프라미스 체인 뒤에 매달아 한 번에 하나씩만 실행되게 한다. 앞선 요청이
// 실패해도(reject) 뒤의 요청이 영원히 막히면 안 되므로, 체인에 이어붙일 때는 성공/실패
// 모두를 흡수한 뒤 다음 링크로 넘긴다.
let writeChain: Promise<void> = Promise.resolve();

function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const previous = writeChain;
  const result = previous.then(task, task);
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// lib/profile.ts의 profileFilledCount()와 같은 8개 필드 기준을 서버에서도 그대로 써야
// 한다(finding 5의 "0개 채움 vs >0개 채움" 판단이 클라이언트와 어긋나면 안 됨). 이 파일은
// 브라우저 전용 모듈(lib/profile.ts, localStorage 접근 포함)을 import할 수 없으므로 같은
// 기준을 여기 복제해둔다.
function filledCount(profile: Profile): number {
  const fields = [
    profile.birthYear,
    profile.birthMonth,
    profile.sido,
    profile.employment,
    profile.annualIncome,
    profile.householdIncome,
    profile.married,
    profile.hasHouse,
  ];
  return fields.filter((v) => v !== undefined).length;
}

// ProfileForm.tsx의 EMPLOYMENT 목록과 반드시 같아야 한다 — EmploymentStatus는 컴파일 타임
// 타입이라 런타임 검증에는 쓸 수 없으므로 여기서 값 목록을 그대로 미러링한다.
const EMPLOYMENT_VALUES = ["재직", "구직", "창업", "재학", "졸업유예", "기타"] as const;
const INCOME_BAND_IDS: IncomeBandId[] = INCOME_BANDS.map((b) => b.id);
const CURRENT_YEAR = new Date().getFullYear();

// 단일 사용자 로컬 앱이지만, `next start`는 기본적으로 LAN 주소(0.0.0.0)에도 바인딩해
// 알린다 — 이 API는 인증이 없으므로 같은 네트워크의 다른 기기가 프로필을 읽거나 덮어쓸
// 수 있다. Host 헤더의 hostname이 localhost/127.0.0.1(포트는 무시)이 아니면 거부한다.
//
// 주의: 이 Next.js 버전은 req.headers['x-forwarded-host'] ??= req.headers['host']를
// base-server.js에서 항상 적용한다(node_modules/next/dist/server/base-server.js:609) —
// 즉 실제 리버스 프록시가 없어도 모든 요청에 x-forwarded-host가 채워져 있다. 그래서
// "x-forwarded-host가 존재하면 거부"는 여기서는 신호가 되지 못하고 로컬 요청까지 막아버린다
// (직접 확인함). 따라서 신뢰 가능한 유일한 신호인 Host 헤더 자체의 hostname만 검사한다.
function isLocalhostRequest(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function forbiddenResponse() {
  return NextResponse.json({ error: "forbidden (localhost only)" }, { status: 403 });
}

// Profile의 각 필드를 화이트리스트 + 타입 검증한다. 정의되지 않은 키는 조용히 버리고,
// 정의된 필드의 타입/범위가 틀리면 전체를 거부(null)한다 — 부분적으로 오염된 프로필을
// 저장하지 않기 위해서다.
function sanitizeProfile(value: unknown): Profile | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const result: Profile = { interests: [] };

  if ("birthYear" in record && record.birthYear !== undefined) {
    const v = record.birthYear;
    if (typeof v !== "number" || !Number.isInteger(v) || v < CURRENT_YEAR - 100 || v > CURRENT_YEAR) return null;
    result.birthYear = v;
  }

  if ("birthMonth" in record && record.birthMonth !== undefined) {
    const v = record.birthMonth;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 12) return null;
    result.birthMonth = v;
  }

  if ("sido" in record && record.sido !== undefined) {
    const v = record.sido;
    if (typeof v !== "string" || v.length !== 2) return null;
    result.sido = v;
  }

  if ("employment" in record && record.employment !== undefined) {
    const v = record.employment;
    if (typeof v !== "string" || !(EMPLOYMENT_VALUES as readonly string[]).includes(v)) return null;
    result.employment = v as Profile["employment"];
  }

  if ("annualIncome" in record && record.annualIncome !== undefined) {
    const v = record.annualIncome;
    // 만원 단위 본인 연소득 — 음수/비정상적으로 큰 값(10억원 = 100000만원 초과)은 거부한다.
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100000) return null;
    result.annualIncome = v;
  }

  if ("householdIncome" in record && record.householdIncome !== undefined) {
    const v = record.householdIncome;
    if (typeof v !== "string" || !INCOME_BAND_IDS.includes(v as IncomeBandId)) return null;
    result.householdIncome = v as Profile["householdIncome"];
  }

  if ("married" in record && record.married !== undefined) {
    const v = record.married;
    if (typeof v !== "boolean") return null;
    result.married = v;
  }

  if ("hasHouse" in record && record.hasHouse !== undefined) {
    const v = record.hasHouse;
    if (typeof v !== "boolean") return null;
    result.hasHouse = v;
  }

  if (!Array.isArray(record.interests)) return null;
  for (const i of record.interests) {
    if (typeof i !== "string" || !(CATEGORIES as readonly string[]).includes(i)) return null;
  }
  result.interests = record.interests as Category[];

  if ("updatedAt" in record && record.updatedAt !== undefined) {
    const v = record.updatedAt;
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return null;
    result.updatedAt = v;
  }

  return result;
}

// 서버에 저장된 프로필을 읽는다. 파일이 없거나(최초 실행) 손상되어 있으면 null —
// 클라이언트는 이를 "서버에 아직 없음"으로 취급하고 localStorage 값을 그대로 쓴다.
export async function GET(request: Request) {
  if (!isLocalhostRequest(request)) return forbiddenResponse();

  try {
    const raw = await fs.readFile(FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Profile;
    return NextResponse.json(parsed);
  } catch {
    return NextResponse.json(null);
  }
}

// 브라우저 저장소(localStorage)가 사라져도(캐시 삭제, 시크릿 모드, 기기 변경 등) 프로필을
// 복원할 수 있도록 서버 파일에도 같은 내용을 남긴다.
export async function PUT(request: Request) {
  if (!isLocalhostRequest(request)) return forbiddenResponse();

  const text = await request.text();
  if (Buffer.byteLength(text, "utf-8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const sanitized = sanitizeProfile(parsed);
  if (!sanitized) {
    return NextResponse.json({ error: "invalid profile" }, { status: 400 });
  }

  // 읽기(stored) → 검증(409 규칙) → 쓰기를 하나의 임계구역으로 묶어 writeChain에 매단다.
  // runSerialized가 앞선 요청의 쓰기가 끝난 뒤에만 이 task를 실행하도록 보장하므로, 두 PUT이
  // 서로 다른 stored 스냅샷을 놓고 각자 통과 판정을 내리는 레이스가 없다.
  const { status, body } = await runSerialized(async () => {
    let stored: Profile | null = null;
    try {
      const raw = await fs.readFile(FILE_PATH, "utf-8");
      stored = JSON.parse(raw) as Profile;
    } catch {
      stored = null; // 파일 없음/손상 — "저장된 값 없음"으로 취급, 아래 검증을 모두 건너뛴다.
    }

    if (stored) {
      const storedTime = stored.updatedAt ? Date.parse(stored.updatedAt) : NaN;
      const incomingTime = sanitized.updatedAt ? Date.parse(sanitized.updatedAt) : NaN;
      // 들어온 값이 저장된 값보다 "확실히" 더 오래된 경우만 거부한다 — 둘 중 하나라도
      // updatedAt이 없거나 파싱 불가면 비교 근거가 없으므로 통과시킨다(과거 동작 유지).
      if (Number.isFinite(storedTime) && Number.isFinite(incomingTime) && incomingTime < storedTime) {
        return { status: 409, body: { error: "stale profile (older than stored)" } };
      }

      const storedFilled = filledCount(stored);
      const incomingFilled = filledCount(sanitized);
      // 채워진 프로필을 빈 프로필로 덮어쓰는 것만 막는다 — 둘 다 비어 있으면(신규 사용자가
      // 아직 아무것도 입력하지 않은 상태를 저장) 정상 케이스이므로 통과.
      if (incomingFilled === 0 && storedFilled > 0) {
        return { status: 409, body: { error: "rejecting empty profile over a filled one" } };
      }
    }

    const tmpFilePath = makeTmpFilePath();
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      // 원자적 쓰기 — 요청마다 고유한 임시 파일에 먼저 쓰고 rename한다. 쓰기 도중 프로세스가
      // 죽거나 동시에 GET이 읽어도, 파일은 항상 이전 내용 아니면 새 내용 중 하나로만 보인다.
      await fs.writeFile(tmpFilePath, JSON.stringify(sanitized), "utf-8");
      await fs.rename(tmpFilePath, FILE_PATH);
    } catch (e) {
      console.error("프로필 서버 저장 실패:", e);
      await fs.unlink(tmpFilePath).catch(() => {}); // 실패한 임시 파일이 data/ 에 쌓이지 않도록 정리
      return { status: 500, body: { error: "write failed" } };
    }

    return { status: 200, body: { ok: true } };
  });

  return NextResponse.json(body, { status });
}

// navigator.sendBeacon()은 항상 POST로 보낸다 — 페이지 이탈 시 대기 중인 저장을 flush하는
// pushServerProfileBeacon(lib/profile.ts)이 그 경로로 여기 닿으므로, PUT과 같은 처리를
// POST의 별칭으로 둔다.
export async function POST(request: Request) {
  return PUT(request);
}
