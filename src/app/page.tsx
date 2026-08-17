"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MotionConfig } from "motion/react";
import ProfileForm from "@/components/ProfileForm";
import PolicyCard from "@/components/PolicyCard";
import FeedStrip from "@/components/FeedStrip";
import { closingSoon, matchAll, missingFieldGains } from "@/lib/match";
import {
  fetchServerProfile,
  loadProfile,
  profileFilledCount,
  pushServerProfile,
  pushServerProfileBeacon,
  saveProfile,
} from "@/lib/profile";
import { formatMonthDay } from "@/lib/format";
import { SEED_POLICIES } from "@/data/policies";
import { EMPTY_PROFILE, type Policy, type Profile } from "@/lib/types";
import styles from "./page.module.css";

// 챙겨야 할 것 패널: 마감 임박 목록이 길 때(실 데이터에서 100건대) 전부 펼쳐두면 패널이
// 화면을 다 채워버린다 — 처음엔 가장 급한 것 위주로 7건만 보이고, 나머지는 펼치기로 연다.
const CLOSING_VISIBLE_CAP = 7;
// 확인 필요 카드도 실 데이터에서 100건대까지 나온다 — 같은 이유로 초반 20건만 보인다.
const NEEDS_INFO_VISIBLE_CAP = 20;

// /api/policies 응답 셰이프 — api 라우트 파일을 import하지 않고 이 화면에서만 쓰는 형태로 로컬 정의.
interface SourceStatus {
  id: string;
  name: string;
  status: "ok" | "no-key" | "error";
  count: number;
}

interface PoliciesResponse {
  sources?: SourceStatus[];
  policies?: Policy[];
}

// 챙겨야 할 것에서 카드로 스크롤한 뒤, 톤 변화만으로 도착을 알린다 (글로우·링 없음).
function flashPolicy(id: string) {
  const el = document.getElementById(`policy-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove(styles.settling);
  el.classList.add(styles.arrived);
  window.setTimeout(() => {
    el.classList.remove(styles.arrived);
    el.classList.add(styles.settling);
    window.setTimeout(() => el.classList.remove(styles.settling), 1200);
  }, 250);
}

function focusField(field: string) {
  const el = document.getElementById(`f-${field}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (el instanceof HTMLElement) el.focus();
}

export default function Home() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [policies, setPolicies] = useState<Policy[]>(SEED_POLICIES);
  const [source, setSource] = useState<string>("내장 데이터");
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [closingExpanded, setClosingExpanded] = useState(false);
  const [needsInfoExpanded, setNeedsInfoExpanded] = useState(false);

  // 로드(초기 복원)로 세팅된 profile 값의 직렬화 스냅샷. save 이펙트가 "사용자가 바꾼 것"과
  // "로드 과정에서 세팅된 것"을 구분하는 기준으로 쓴다 — 후자에는 저장을 다시 트리거하지 않는다.
  const lastLoadedRef = useRef<string>("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 항상 "지금" 화면에 있는 profile을 동기적으로 들고 있는 참조. fetchServerProfile()의
  // 비동기 응답이 도착했을 때, 클로저에 잡힌 마운트 시점 값(local) 대신 이 ref를 읽어야
  // 그 사이 사용자가 입력한 편집을 서버 값으로 덮어쓰지 않는다.
  const profileRef = useRef<Profile>(EMPTY_PROFILE);
  // 800ms 디바운스 타이머가 아직 발화하지 않아 "보낼 게 남아있는" 상태인지 표시.
  // pagehide/unmount 시 이 플래그가 서 있으면 디바운스를 기다리지 않고 즉시 flush한다.
  const pendingPushRef = useRef(false);

  // ProfileForm에서 올라오는 모든 사용자 변경에 updatedAt을 찍는다(ProfileForm 쪽이 아니라
  // 여기서 하는 이유: 로드 과정에서 세팅되는 profile에는 새 타임스탬프를 찍지 않아야 하므로,
  // "사용자가 실제로 편집했다"는 이 콜백이 그 경계다). 로컬/서버 병합의 last-write-wins 기준.
  function handleProfileChange(next: Profile) {
    const stamped: Profile = { ...next, updatedAt: new Date().toISOString() };
    profileRef.current = stamped;
    setProfile(stamped);
  }

  // 마운트 후 저장된 프로필을 불러온다 (하이드레이션 불일치 방지).
  // 1) localStorage를 먼저 읽어 빠르게 그려주고, 2) 서버 파일과 대조해 updatedAt이 더 최신인
  // 쪽을 채택한다(last-write-wins). 서버 재시작이나 브라우저 저장소 삭제로 한쪽이 비어도
  // 다른 쪽으로 복원되게 하는 것이 목적.
  useEffect(() => {
    const local = loadProfile();
    profileRef.current = local;
    lastLoadedRef.current = JSON.stringify(local);
    setProfile(local);

    fetchServerProfile().then((server) => {
      // 클로저의 local이 아니라 ref를 읽는다 — fetch가 걸려있는 동안 사용자가 이미
      // 편집했다면 그 편집이 "현재" 값이고, local은 낡은 값이다.
      const current = profileRef.current;

      if (!server) {
        // 서버에 아직 파일이 없음(최초 실행) — 현재 값이 있으면 서버에도 남겨둔다.
        if (profileFilledCount(current).filled > 0) pushServerProfile(current);
        return;
      }

      const currentTime = current.updatedAt ? Date.parse(current.updatedAt) : 0;
      const serverTime = server.updatedAt ? Date.parse(server.updatedAt) : 0;

      let serverWins: boolean;
      if (currentTime !== serverTime) {
        serverWins = serverTime > currentTime;
      } else if (currentTime === 0 && serverTime === 0) {
        // 둘 다 updatedAt이 없음(구버전 데이터) — 채움 개수 규칙으로 폴백.
        serverWins = profileFilledCount(server).filled >= profileFilledCount(current).filled;
      } else {
        // 타임스탬프가 동일하고 둘 다 존재 — 누가 더 최신인지 판단할 수 없으므로,
        // 방금 편집했을 수 있는 현재 값을 패자로 만들지 않는다.
        serverWins = false;
      }

      if (serverWins) {
        // 서버가 승자일 때만 서버 값을 채택한다 — 패자를 승자 위에 쓰지 않는다.
        profileRef.current = server;
        lastLoadedRef.current = JSON.stringify(server);
        setProfile(server);
        saveProfile(server);
      } else {
        // 서버가 패자(또는 동률로 보호됨) — 서버를 덮어쓰지 않고, 승자(현재 값)를 서버에 반영.
        pushServerProfile(current);
      }
    });
  }, []);

  // 마운트 후에만 현재 시각을 확정한다 — 서버 렌더/정적 HTML에 시간이 박히면 안 된다.
  useEffect(() => {
    setNow(new Date());
  }, []);

  // 프로필을 불러오기 전(null)에 빈 프로필로 덮어 저장하지 않도록 로드가 끝난 뒤에만 저장.
  // 또한 위 로드 시퀀스가 setProfile로 세팅한 값 자체는 "사용자가 바꾼 것"이 아니므로
  // 다시 저장/전송하지 않는다 — lastLoadedRef와 비교해 실제 변경일 때만 저장한다.
  useEffect(() => {
    if (profile === null) return;
    const serialized = JSON.stringify(profile);
    if (serialized === lastLoadedRef.current) return;
    lastLoadedRef.current = serialized;

    saveProfile(profile);

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    pendingPushRef.current = true;
    saveTimerRef.current = setTimeout(() => {
      pendingPushRef.current = false;
      pushServerProfile(profile);
    }, 800);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [profile]);

  // 탭을 닫거나 다른 페이지로 이동할 때(pagehide), 아직 디바운스 타이머가 끝나지 않은
  // PUT이 있다면 800ms를 기다리지 않고 즉시 flush한다. 이 이펙트는 deps가 []이므로
  // 클린업이 실제 unmount에서만 실행된다 — 위 저장 이펙트([profile] 의존)의 클린업과
  // 합치면, profile이 바뀔 때마다(=키 입력마다) 발생하는 클린업까지 flush를 트리거해서
  // 디바운스 자체가 무력화되는 문제가 생긴다. 그래서 flush 전용 이펙트를 따로 둔다.
  useEffect(() => {
    const flush = () => {
      if (!pendingPushRef.current) return;
      pendingPushRef.current = false;
      // 디바운스 타이머를 취소해야 한다 — 그렇지 않으면 flush로 이미 보낸 뒤에도 800ms 시점에
      // 원래 타이머가 그대로 발화해 같은 내용을 중복 전송한다(무해하지만 불필요한 요청).
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      pushServerProfileBeacon(profileRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  // 실 데이터가 있으면 시드를 교체하고, 실패하거나 아무 소스도 살아있지 않으면 시드를 유지.
  useEffect(() => {
    let active = true;
    fetch("/api/policies")
      .then((res) => res.json())
      .then((json: PoliciesResponse) => {
        if (!active) return;
        const srcs = Array.isArray(json.sources) ? json.sources : [];
        setSources(srcs);

        // seed(내장 데이터)를 제외한 나머지 소스가 전부 "no-key"면 살아있는 소스가 없다는 뜻 —
        // 불필요한 재정렬을 피하고 내장 시드를 그대로 둔다.
        const liveSources = srcs.filter((s) => s.id !== "seed");
        const nothingLive = liveSources.every((s) => s.status === "no-key");
        if (nothingLive) return;

        if (Array.isArray(json.policies) && json.policies.length > 0) {
          setPolicies(json.policies);
          const okSources = liveSources.filter((s) => s.status === "ok");
          if (okSources.length > 0) {
            // 실제로 "ok" 상태인 소스가 하나라도 있을 때만 실시간 연동을 주장한다.
            setSource(`${okSources.map((s) => s.name).join("·")} 연동(일부 내장)`);
          } else {
            // 라이브 소스 키는 있지만 전부 오류 — 서빙되는 것은 100% 내장 시드이므로
            // "실시간 연동"이라 주장하면 거짓이다. 상세 오류는 footer의 sourceStatus 줄이 전달한다.
            setSource("내장 데이터");
          }
        }
      })
      .catch(() => {
        // 네트워크 실패 시 내장 시드 데이터를 그대로 사용.
      });
    return () => {
      active = false;
    };
  }, []);

  const p = profile ?? EMPTY_PROFILE;

  const results = useMemo(() => matchAll(policies, p, now), [policies, p, now]);

  const availableNow = useMemo(
    () =>
      results.filter(
        (r) => r.verdict === "eligible" && !r.closed && r.policy.apply.kind !== "공고예정",
      ),
    [results],
  );
  const upcomingAnnouncement = useMemo(
    () => results.filter((r) => r.verdict === "eligible" && r.policy.apply.kind === "공고예정"),
    [results],
  );
  const needsInfoResults = useMemo(
    () => results.filter((r) => r.verdict === "needsInfo" && !r.closed),
    [results],
  );
  const otherResults = useMemo(
    () => results.filter((r) => r.verdict === "ineligible" || r.closed),
    [results],
  );
  const closing = useMemo(() => closingSoon(results, 30), [results]);
  const gains = useMemo(() => missingFieldGains(results), [results]);
  const visibleClosing = closingExpanded ? closing : closing.slice(0, CLOSING_VISIBLE_CAP);
  const hiddenClosingCount = Math.max(0, closing.length - CLOSING_VISIBLE_CAP);
  const visibleNeedsInfo = needsInfoExpanded ? needsInfoResults : needsInfoResults.slice(0, NEEDS_INFO_VISIBLE_CAP);
  const hiddenNeedsInfoCount = Math.max(0, needsInfoResults.length - NEEDS_INFO_VISIBLE_CAP);

  // 연동 상태 표시용 — 내장 시드는 "연동 상태"의 대상이 아니므로 제외.
  const liveSources = useMemo(() => sources.filter((s) => s.id !== "seed"), [sources]);
  const nothingLive = useMemo(
    () => liveSources.every((s) => s.status === "no-key"),
    [liveSources],
  );

  const updatedAt = policies[0]?.updatedAt ?? "";
  const showInvite = availableNow.length === 0 && profileFilledCount(p).filled <= 1;
  const showChecklistPanel = closing.length > 0 || gains.length > 0;

  // 이미 채워진 항목은 "입력하면"이 아니라 "다시 확인하면"이라고 정확히 안내한다.
  function isFieldFilled(field: keyof Profile): boolean {
    const v = p[field];
    if (v === undefined) return false;
    if (field === "householdIncome" && v === "unknown") return false;
    return true;
  }

  return (
    <MotionConfig reducedMotion="user">
      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.headingBlock}>
            <h1 className={styles.heading}>지금 챙길 수 있는 정책</h1>
            <p className={styles.lead}>프로필 기준으로 청년 정책·지원금을 판정합니다.</p>
            <p className={styles.dataNote}>
              데이터 기준 {updatedAt} · {source} · 신청 전 반드시 공식 공고를 확인하세요.
            </p>
          </div>

          <div className={styles.figures}>
            <div className={styles.figure}>
              <span className={`${styles.figureNum} ${styles.numEligible}`}>{availableNow.length}</span>
              <span className={styles.figureLabel}>지금 신청 가능</span>
            </div>
            <div className={styles.figure}>
              <span className={`${styles.figureNum} ${styles.numNeeds}`}>{needsInfoResults.length}</span>
              <span className={styles.figureLabel}>확인 필요</span>
            </div>
            <div className={styles.figure}>
              <span className={`${styles.figureNum} ${styles.numClosing}`}>{closing.length}</span>
              <span className={styles.figureLabel}>마감 임박·예상 포함</span>
            </div>
          </div>
        </section>

        <div className={styles.layout}>
          <aside className={styles.aside}>
            <ProfileForm profile={p} onChange={handleProfileChange} />
          </aside>

          <div className={styles.content}>
            {showChecklistPanel && (
              <section className={styles.panel}>
                <h2 className={styles.panelTitle}>
                  챙겨야 할 것 <span className={styles.panelCount}>{closing.length + gains.length}건</span>
                </h2>
                <ul className={styles.checklist}>
                  {/* 개인화된 항목(입력하면 판정이 갈리는 필드)이 가장 실행 가능성이 높으므로
                      항상 먼저 보인다 — 마감 임박 목록이 100건대로 길어져도 이 항목들이
                      맨 아래로 밀려나지 않는다. */}
                  {gains.map((g) => {
                    const filled = isFieldFilled(g.field);
                    return (
                      <li key={g.field}>
                        <button
                          type="button"
                          className={styles.checklistRow}
                          onClick={() => focusField(g.field)}
                        >
                          <span>「{g.label}」 {filled ? "다시 확인하면" : "입력하면"}</span>
                          <span className={styles.gainCount}>{g.count}건 판정 확정</span>
                        </button>
                      </li>
                    );
                  })}
                  {visibleClosing.map((r) => (
                    <li key={r.policy.id}>
                      <button
                        type="button"
                        className={styles.checklistRow}
                        onClick={() => flashPolicy(r.policy.id)}
                      >
                        <span>{r.policy.name}</span>
                        <span className={styles.dday}>
                          {r.policy.apply.estimated && r.policy.apply.end
                            ? `~${formatMonthDay(r.policy.apply.end)} 예상`
                            : r.dday === 0
                              ? "오늘 마감"
                              : `D-${r.dday}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {(closingExpanded || hiddenClosingCount > 0) && (
                  <button
                    type="button"
                    className={styles.checklistExpander}
                    onClick={() => setClosingExpanded((v) => !v)}
                  >
                    {closingExpanded ? "접기" : `+${hiddenClosingCount}건 더 보기`}
                  </button>
                )}
              </section>
            )}

            <FeedStrip />

            {availableNow.length > 0 && (
              <section className={styles.group}>
                <h2 className={styles.groupTitle}>
                  지금 신청 가능 <span className={styles.groupCount}>{availableNow.length}건</span>
                </h2>
                <div className={styles.stack}>
                  {availableNow.map((r) => (
                    <div id={`policy-${r.policy.id}`} className={styles.cardWrap} key={r.policy.id}>
                      <PolicyCard result={r} now={now} />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {showInvite && (
              <p className={styles.invite}>프로필을 입력하면 신청 가능한 정책을 바로 확인할 수 있어요.</p>
            )}

            {upcomingAnnouncement.length > 0 && (
              <section className={styles.group}>
                <h2 className={styles.groupTitle}>
                  공고 뜨면 신청 가능 <span className={styles.groupCount}>{upcomingAnnouncement.length}건</span>
                </h2>
                <div className={styles.stack}>
                  {upcomingAnnouncement.map((r) => (
                    <div id={`policy-${r.policy.id}`} className={styles.cardWrap} key={r.policy.id}>
                      <PolicyCard result={r} now={now} />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {needsInfoResults.length > 0 && (
              <section className={styles.group}>
                <h2 className={styles.groupTitle}>
                  입력하면 판정 확정 <span className={styles.groupCount}>{needsInfoResults.length}건</span>
                </h2>
                <div className={styles.stack}>
                  {visibleNeedsInfo.map((r) => (
                    <div id={`policy-${r.policy.id}`} className={styles.cardWrap} key={r.policy.id}>
                      <PolicyCard result={r} now={now} />
                    </div>
                  ))}
                </div>
                {(needsInfoExpanded || hiddenNeedsInfoCount > 0) && (
                  <button
                    type="button"
                    className={styles.groupExpander}
                    onClick={() => setNeedsInfoExpanded((v) => !v)}
                  >
                    {needsInfoExpanded ? "접기" : `더 보기 (+${hiddenNeedsInfoCount}건)`}
                  </button>
                )}
              </section>
            )}

            {otherResults.length > 0 && (
              <details className={styles.otherGroup}>
                <summary className={styles.otherSummary}>대상 아님 · 접수 마감 {otherResults.length}건</summary>
                <div className={styles.stack}>
                  {otherResults.map((r) => (
                    <div id={`policy-${r.policy.id}`} className={styles.cardWrap} key={r.policy.id}>
                      <PolicyCard result={r} now={now} />
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>

        <footer className={styles.footer}>
          <div className={styles.footerBrand}>
            <span className={styles.footerWordmark}>채비</span>
            <p className={styles.footerTagline}>경험을 정리하고, 챙길 것을 놓치지 않도록.</p>
          </div>
          <div className={styles.footerNote}>
            <p>
              데이터 기준 {updatedAt} · {source}
            </p>
            <p>판정은 참고용입니다. 신청 전 반드시 공식 공고를 확인하세요.</p>
            <p>입력한 정보는 이 컴퓨터(브라우저와 data/profile.json)에만 저장됩니다.</p>
            {nothingLive ? (
              <p className={styles.sourceStatusEmpty}>
                실시간 연동: 공공데이터포털 키를 등록하면 온통청년·보조금24·복지로·K-스타트업 공고가 실시간
                반영됩니다
              </p>
            ) : (
              <p className={styles.sourceStatus}>
                {liveSources.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && <span className={styles.sourceSep}> · </span>}
                    <span
                      className={
                        s.status === "ok"
                          ? styles.sourceOk
                          : s.status === "error"
                            ? styles.sourceError
                            : styles.sourceNoKey
                      }
                    >
                      {s.name} {s.status === "ok" ? `연결됨 ${s.count}건` : s.status === "error" ? "오류" : "키 필요"}
                    </span>
                  </span>
                ))}
              </p>
            )}
          </div>
        </footer>
      </main>
    </MotionConfig>
  );
}
