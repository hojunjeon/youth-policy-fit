import type { Policy } from "@/lib/types";

// 정책 데이터 소스 커넥터 공통 계약.
// route.ts는 이 인터페이스만 알면 되고, 커넥터별 API 스펙(엔드포인트·파싱)은
// 각 파일 안에 캡슐화한다. 새 소스를 추가할 때는 Connector를 구현해 registry에 등록만 하면 된다.

export interface SourceStatus {
  id: string;
  name: string;
  status: "ok" | "no-key" | "error";
  count: number;
}

export interface Connector {
  id: string;
  name: string;
  requiredEnv?: string; // 없으면 키 불필요(예: 정부24 RSS는 별도 라우트)
  // requiredEnv와 달리 키가 없어도 커넥터를 항상 실행한다 — 키가 있으면 fetchPolicies에 전달돼
  // 요청에 함께 실려나가지만(예: serviceKey 파라미터), 없어도 무키로 호출을 시도한다.
  optionalEnv?: string;
  fetchPolicies(key: string, signal?: AbortSignal): Promise<Policy[]>;
}
