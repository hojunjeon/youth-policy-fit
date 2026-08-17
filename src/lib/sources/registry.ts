import type { Connector } from "@/lib/sources/types";
import { youthcenterConnector } from "@/lib/sources/youthcenter";
import { govbenefitsConnector } from "@/lib/sources/govbenefits";
import { welfareConnector } from "@/lib/sources/welfare";
import { kstartupConnector } from "@/lib/sources/kstartup";

// 등록된 정책 데이터 커넥터 전체 목록. 새 소스를 추가할 때는 Connector를 구현해 여기에 더한다.
export const CONNECTORS: Connector[] = [youthcenterConnector, govbenefitsConnector, welfareConnector, kstartupConnector];
