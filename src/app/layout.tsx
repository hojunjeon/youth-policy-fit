import type { Metadata } from "next";
import Link from "next/link";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "@fontsource-variable/hahmlet";
import "./globals.css";
import styles from "./layout.module.css";
import NavLinks from "@/components/NavLinks";

export const metadata: Metadata = {
  title: "채비 · 정책 매칭",
  description: "내 경험과 프로필로 챙길 수 있는 청년 정책·지원금을 찾아주는 개인 경험 관리 앱",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className={styles.header}>
          <Link href="/" className={styles.wordmark}>
            채비
          </Link>
          <NavLinks />
        </header>
        {children}
      </body>
    </html>
  );
}
