import Link from "next/link";
import styles from "@/app/stub.module.css";

export default function ExperiencePage() {
  return (
    <main className={styles.wrap}>
      <h1 className={styles.heading}>경험 DB</h1>
      <div className={styles.body}>
        <p>프로젝트, 동아리, 대외활동에서 쌓은 경험을 한곳에 모아 정리하는 저장소입니다.</p>
        <p>여기에 쌓인 경험은 자소서 초안과 포트폴리오, 정책 매칭 프로필의 단일 소스로 함께 쓰입니다.</p>
        <p>아직 준비 중입니다.</p>
      </div>
      <Link href="/" className={styles.back}>
        정책 매칭으로 돌아가기
      </Link>
    </main>
  );
}
