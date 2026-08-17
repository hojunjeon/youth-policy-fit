"use client";

import { useEffect, useState } from "react";
import { CATEGORIES, INCOME_BANDS, type EmploymentStatus, type Profile } from "@/lib/types";
import { REGIONS } from "@/data/regions";
import { profileFilledCount } from "@/lib/profile";
import styles from "./ProfileForm.module.css";

const EMPLOYMENT: EmploymentStatus[] = ["재직", "구직", "창업", "재학", "졸업유예", "기타"];

interface Props {
  profile: Profile;
  onChange: (next: Profile) => void;
}

export default function ProfileForm({ profile, onChange }: Props) {
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    onChange({ ...profile, [key]: value });

  const years: number[] = [];
  const thisYear = new Date().getFullYear();
  for (let y = thisYear - 15; y >= thisYear - 45; y--) years.push(y);

  // 타이핑마다 프로필을 갈아엎지 않도록(재정렬·저장 폭주 방지) 로컬 문자열로 들고 있다가 blur/Enter에만 커밋.
  const [incomeInput, setIncomeInput] = useState(profile.annualIncome?.toString() ?? "");
  useEffect(() => {
    setIncomeInput(profile.annualIncome?.toString() ?? "");
  }, [profile.annualIncome]);

  const commitIncome = () => {
    const next = incomeInput === "" ? undefined : Number(incomeInput);
    if (next !== profile.annualIncome) set("annualIncome", next);
  };

  const { filled, total } = profileFilledCount(profile);

  return (
    <form className={styles.form} onSubmit={(e) => e.preventDefault()}>
      <div className={styles.head}>
        <h2>내 정보</h2>
        <span className={styles.meterLabel}>
          {filled}<em>/{total} 입력</em>
        </span>
      </div>
      <div className={styles.meter} aria-hidden="true">
        <div className={styles.meterFill} style={{ width: `${(filled / total) * 100}%` }} />
      </div>
      <p className={styles.hint}>
        입력할수록 판정이 정확해져요. 입력한 정보는 이 컴퓨터(브라우저와 data/profile.json)에만 저장됩니다.
      </p>

      <div className={styles.row2}>
        <label className="field">
          <span>출생 연도</span>
          <select
            id="f-birthYear"
            value={profile.birthYear ?? ""}
            onChange={(e) => set("birthYear", e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">선택</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}년
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>출생 월</span>
          <select
            id="f-birthMonth"
            value={profile.birthMonth ?? ""}
            onChange={(e) => set("birthMonth", e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">선택</option>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m}월
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>거주 지역</span>
        <select
          id="f-sido"
          value={profile.sido ?? ""}
          onChange={(e) => set("sido", e.target.value || undefined)}
        >
          <option value="">선택</option>
          {REGIONS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>취업 상태</span>
        <select
          id="f-employment"
          value={profile.employment ?? ""}
          onChange={(e) => set("employment", (e.target.value || undefined) as EmploymentStatus | undefined)}
        >
          <option value="">선택</option>
          {EMPLOYMENT.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>본인 연소득 (만원)</span>
        <input
          id="f-annualIncome"
          type="number"
          min={0}
          step={100}
          placeholder="예: 3200 (없으면 0)"
          value={incomeInput}
          onChange={(e) => setIncomeInput(e.target.value)}
          onBlur={commitIncome}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitIncome();
            }
          }}
        />
      </label>

      <label className="field">
        <span>가구소득 구간 (기준중위소득)</span>
        <select
          id="f-householdIncome"
          value={profile.householdIncome ?? ""}
          onChange={(e) => set("householdIncome", (e.target.value || undefined) as Profile["householdIncome"])}
        >
          <option value="">선택</option>
          {INCOME_BANDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.row2}>
        <label className="field">
          <span>혼인 여부</span>
          <select
            id="f-married"
            value={profile.married === undefined ? "" : profile.married ? "y" : "n"}
            onChange={(e) => set("married", e.target.value === "" ? undefined : e.target.value === "y")}
          >
            <option value="">선택</option>
            <option value="n">미혼</option>
            <option value="y">기혼</option>
          </select>
        </label>
        <label className="field">
          <span>주택 보유</span>
          <select
            id="f-hasHouse"
            value={profile.hasHouse === undefined ? "" : profile.hasHouse ? "y" : "n"}
            onChange={(e) => set("hasHouse", e.target.value === "" ? undefined : e.target.value === "y")}
          >
            <option value="">선택</option>
            <option value="n">무주택</option>
            <option value="y">보유</option>
          </select>
        </label>
      </div>

      <fieldset className={styles.interests}>
        <legend>관심 분야</legend>
        <div className={styles.interestGrid}>
          {CATEGORIES.map((c) => {
            const on = profile.interests.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                className={on ? styles.interestOn : styles.interest}
                onClick={() =>
                  set(
                    "interests",
                    on ? profile.interests.filter((i) => i !== c) : [...profile.interests, c],
                  )
                }
              >
                {c}
              </button>
            );
          })}
        </div>
      </fieldset>
    </form>
  );
}
