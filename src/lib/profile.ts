import { EMPTY_PROFILE, type Profile } from "@/lib/types";

// 프로필 저장소 — 지금은 localStorage, 이후 경험 DB 백엔드로 교체할 수 있게 한 파일로 격리.
const KEY = "chaebi.profile.v1";

// 프로필 입력 완성도 — 채워진 항목 수 / 전체 항목 수. ProfileForm의 진행률 표시와
// page.tsx의 "초기 안내" 노출 여부 판단이 같은 8개 항목 기준을 공유하도록 한 곳에 둔다.
export function profileFilledCount(profile: Profile): { filled: number; total: number } {
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
  return { filled: fields.filter((v) => v !== undefined).length, total: fields.length };
}

export function loadProfile(): Profile {
  if (typeof window === "undefined") return EMPTY_PROFILE;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY_PROFILE;
    const parsed = JSON.parse(raw) as Profile;
    return { ...EMPTY_PROFILE, ...parsed };
  } catch {
    return EMPTY_PROFILE;
  }
}

export function saveProfile(profile: Profile): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Safari 프라이빗 모드, 저장 용량 초과 등 — 저장은 실패해도 앱은 계속 동작해야 한다.
  }
}

// 서버에 저장된 프로필을 읽는다. 서버가 없거나, 파일이 아직 없거나, 요청이 실패해도
// null을 돌려주고 호출부(page.tsx)가 localStorage 값으로 계속 동작하게 한다.
export async function fetchServerProfile(): Promise<Profile | null> {
  try {
    const res = await fetch("/api/profile", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    if (data === null || typeof data !== "object") return null;
    return { ...EMPTY_PROFILE, ...(data as Profile) };
  } catch {
    return null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function putProfile(profile: Profile): Promise<Response> {
  return fetch("/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
}

// 서버에 프로필을 반영한다. 실패해도 조용히 무시한다 — localStorage가 항상 폴백이다.
// - 409(서버 라우트의 충돌 규칙: 더 최신 저장값이 있거나, 빈 프로필로 채워진 값을
//   덮어쓰려는 경우)는 "이번 반영을 건너뛰는 것이 맞다"는 서버의 판단이므로 조용히
//   받아들이고 재시도하지 않는다 — 재시도해도 같은 이유로 다시 거부될 뿐이다.
// - 그 외 실패(네트워크 오류, 5xx 등)는 일시적일 수 있으므로 한 번만 재시도한다.
export async function pushServerProfile(profile: Profile): Promise<void> {
  try {
    const res = await putProfile(profile);
    if (res.ok || res.status === 409) return;
  } catch {
    // 네트워크 실패 — 아래에서 한 번 재시도한다.
  }

  await wait(500);

  try {
    const res = await putProfile(profile);
    if (!res.ok && res.status !== 409) {
      console.error(`프로필 서버 반영 실패 (status ${res.status})`);
    }
  } catch {
    // 재시도까지 실패 — 다음 변경 때 다시 시도되므로 여기서는 무시한다.
  }
}

// 탭이 닫히거나 페이지를 떠나는 시점(pagehide)에 800ms 디바운스를 기다릴 수 없을 때 쓴다.
// sendBeacon은 페이지가 언로드되는 도중에도 브라우저가 전송을 보장해준다 — 일반 fetch는
// 이 시점에 취소될 수 있다. sendBeacon은 항상 POST로 보내므로 API 라우트가 POST를 PUT의
// 별칭으로 받아줘야 한다. sendBeacon이 없거나 실패하면 keepalive fetch로 폴백한다.
export function pushServerProfileBeacon(profile: Profile): void {
  if (typeof window === "undefined") return;
  const body = JSON.stringify(profile);
  try {
    if (typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      const accepted = navigator.sendBeacon("/api/profile", blob);
      if (accepted) return;
    }
  } catch {
    // sendBeacon 실패 — 아래 fetch 폴백으로 이어간다.
  }
  try {
    void fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // 페이지 종료 시점의 네트워크 오류 — 더 할 수 있는 게 없으므로 무시한다.
  }
}
