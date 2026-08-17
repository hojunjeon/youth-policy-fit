"use client";

import { useEffect, useState } from "react";
import styles from "./FeedStrip.module.css";

// /api/feed 응답 셰이프 — 이 화면에서만 쓰는 형태로 로컬 정의.
interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

interface FeedResponse {
  items?: FeedItem[];
}

// pubDate → "N분/시간/일 전", 7일 이상이면 "M.D" 절대 표기(연도가 올해와 다르면 "YYYY.M.D").
// 파싱 실패 시 null(날짜 부분 생략).
function relativeTime(pubDate: string, now: number): string | null {
  const then = Date.parse(pubDate);
  if (Number.isNaN(then)) return null;

  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;

  const d = new Date(then);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}.${d.getDate()}`
    : `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

export default function FeedStrip() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    fetch("/api/feed")
      .then((res) => res.json())
      .then((json: FeedResponse) => {
        if (!active) return;
        if (Array.isArray(json.items)) setItems(json.items);
      })
      .catch(() => {
        // RSS 실패 시 이 섹션은 그냥 나타나지 않는다 — 부가 정보이므로 재시도하지 않는다.
      });
    return () => {
      active = false;
    };
  }, []);

  // 상대 시각("방금"/"N분 전")이 세션이 길어져도 계속 맞도록 60초마다 갱신.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // 로딩 중이거나 비었을 때는 아무것도 그리지 않는다 — 스켈레톤·진입 애니메이션 없이,
  // 데이터가 도착하면 섹션이 그 자체로 나타난다.
  if (items.length === 0) return null;

  return (
    <section className={styles.feed}>
      <h2 className={styles.heading}>정부24 새 소식</h2>
      <p className={styles.subheading}>최근 30일 · 서비스 등록·변경 소식</p>
      <ul className={styles.list}>
        {items.slice(0, 6).map((item, i) => {
          const rel = relativeTime(item.pubDate, now);
          return (
            <li key={`${item.link}-${i}`} className={styles.row}>
              <a href={item.link} target="_blank" rel="noreferrer" className={styles.title}>
                {item.title}
              </a>
              <span className={styles.meta}>
                {item.source}
                {rel ? ` · ${rel}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
