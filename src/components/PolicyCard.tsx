"use client";

import { motion } from "motion/react";
import type { MatchResult } from "@/lib/types";
import { formatMonthDay } from "@/lib/format";
import styles from "./PolicyCard.module.css";

export default function PolicyCard({ result, now }: { result: MatchResult; now: Date | null }) {
  const { policy, verdict, reasons, blockers, unknowns, dday, closed } = result;

  const windowLabel = (() => {
    if (closed) return "접수 마감";
    if (policy.apply.kind === "상시") return policy.apply.cycle ?? "상시 접수";
    if (policy.apply.kind === "공고예정") return policy.apply.cycle ?? "공고 예정";
    if (policy.apply.kind === "기간" && policy.apply.estimated && policy.apply.end) {
      return `~${formatMonthDay(policy.apply.end)} 마감 예상`;
    }
    // now === null(하이드레이션 전)에는 시간 기반 텍스트를 절대 노출하지 않는다.
    if (now !== null && dday !== null) return dday === 0 ? "오늘 마감" : `D-${dday}`;
    if (policy.apply.start) return `${policy.apply.start.slice(5).replace("-", ".")} 접수 시작`;
    return "기간 접수";
  })();

  const urgent = dday !== null && dday <= 14 && verdict !== "ineligible" && !closed;

  return (
    <motion.article
      layout
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className={`${styles.card} ${closed ? styles.closed : ""}`}
      data-verdict={verdict}
    >
      <div className={styles.meta}>
        <span>
          {policy.category} · {policy.agency}
        </span>
        <span className={urgent ? styles.urgent : styles.window}>{windowLabel}</span>
      </div>

      <h3 className={styles.name}>{policy.name}</h3>
      <p className={styles.summary}>{policy.summary}</p>
      <p className={styles.benefit}>{policy.benefit}</p>

      <ul className={styles.judge}>
        {verdict === "ineligible" ? (
          <>
            {blockers.map((t) => (
              <li key={t} className={styles.no}>
                {t}
              </li>
            ))}
            {unknowns.map((u) => (
              <li key={u.label} className={styles.ask}>
                {u.label} 입력 시 판정 확정
              </li>
            ))}
            {reasons.map((t) => (
              <li key={t} className={styles.ok}>
                {t}
              </li>
            ))}
          </>
        ) : (
          <>
            {reasons.map((t) => (
              <li key={t} className={styles.ok}>
                {t}
              </li>
            ))}
            {unknowns.map((u) => (
              <li key={u.label} className={styles.ask}>
                {u.label} 입력 시 판정 확정
              </li>
            ))}
            {blockers.map((t) => (
              <li key={t} className={styles.no}>
                {t}
              </li>
            ))}
          </>
        )}
        {policy.rule.note && <li className={styles.note}>{policy.rule.note}</li>}
      </ul>

      <div className={styles.foot}>
        <details className={styles.checklist}>
          <summary>신청 전 챙길 것 {policy.checklist.length}가지</summary>
          <ol>
            {policy.checklist.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        </details>
        <a href={policy.url} target="_blank" rel="noreferrer" className={styles.link}>
          공고 확인 <span aria-hidden>↗</span>
        </a>
      </div>
    </motion.article>
  );
}
