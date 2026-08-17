"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "@/app/layout.module.css";

const ITEMS = [
  { href: "/experience", label: "경험" },
  { href: "/essay", label: "자소서" },
  { href: "/", label: "정책" },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className={styles.nav} aria-label="주요 기능">
      {ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={active ? styles.active : undefined}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
