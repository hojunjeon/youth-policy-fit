import Link from "next/link";
import styles from "@/app/stub.module.css";

export default function EssayPage() {
  return (
    <main className={styles.wrap}>
      <h1 className={styles.heading}>자소서 초안</h1>
      <div className={styles.body}>
        <p>채용공고와 문항을 입력하면 문항의 의도를 분석하고, 경험 DB에서 맞는 경험을 찾아 작성 흐름을 설계합니다.</p>
        <p>초안이 완성되면 그대로 다듬어 제출할 수 있는 수준까지 이어질 예정입니다.</p>
        <p>아직 준비 중입니다.</p>
      </div>
      <Link href="/" className={styles.back}>
        정책 매칭으로 돌아가기
      </Link>
    </main>
  );
}
