import { XMLParser } from "fast-xml-parser";
import { NextResponse } from "next/server";
import { asArray } from "@/lib/sources/normalize";

// 정부24 RSS(키 불필요) 중 청년정책과 관련도가 높은 4개 카테고리만 골라 병합한다.
// 전체 목록은 https://www.gov.kr/portal/rss 에서 확인했고, 인덱스 페이지의 실제 링크는
// "/portal/rss/010000" 형태다(단순 "/rss/010000"은 404 — curl로 직접 확인).
//   curl -L https://www.gov.kr/portal/rss/010000 → HTTP 200, content-type application/rss+xml
const FEEDS: { code: string; label: string }[] = [
  { code: "010000", label: "취업·직장" },
  { code: "020000", label: "창업·경영" },
  { code: "060000", label: "결혼·육아·교육" },
  { code: "090000", label: "주택·부동산" },
];

const BASE = "https://www.gov.kr";

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

interface RawRssItem {
  title?: unknown;
  link?: unknown;
  pubDate?: unknown;
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

async function fetchFeed(feed: { code: string; label: string }): Promise<FeedItem[]> {
  const res = await fetch(`${BASE}/portal/rss/${feed.code}`, { next: { revalidate: 1800 } });
  if (!res.ok) throw new Error(`gov.kr rss ${feed.code} ${res.status}`);
  const xml = await res.text();
  const json = parser.parse(xml);
  const items = asArray<RawRssItem>(json?.rss?.channel?.item);
  const out: FeedItem[] = [];
  for (const it of items) {
    const title = textOf(it?.title);
    const rawLink = textOf(it?.link);
    if (!title || !rawLink) continue;
    const link = rawLink.startsWith("http") ? rawLink : `${BASE}${rawLink}`;
    out.push({ title, link, pubDate: textOf(it?.pubDate), source: feed.label });
  }
  return out;
}

// 정부24 공공서비스 피드는 이미 "서비스" 단위로 구성돼 있어 대부분 정책/혜택 성격을 띤다.
// 제목이 없거나 지나치게 짧은(내비게이션성) 항목만 배제하는 최소한의 필터를 둔다.
function isPolicyLike(item: FeedItem): boolean {
  return item.title.length >= 2;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// 유효하지 않은 pubDate(파싱 실패)는 정렬 기준으로 0(1970년)을 쓰면 안 된다 — 그러면
// "가장 오래된" 취급을 받는 게 아니라 파싱 실패 항목들이 전부 동일 시각으로 뭉쳐 정렬
// 순서가 뒤섞인다. 파싱 실패/30일 초과 항목은 애초에 목록에서 제외한다.
function parsePubDateMs(pubDate: string): number | null {
  const t = Date.parse(pubDate);
  return Number.isFinite(t) ? t : null;
}

export async function GET() {
  const settled = await Promise.allSettled(FEEDS.map(fetchFeed));

  const rawItems: FeedItem[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") rawItems.push(...result.value.filter(isPolicyLike));
    // 실패한 개별 피드는 조용히 건너뛴다 — 전체 실패여도 200 + 빈 배열을 내려줘야 하므로
    // 여기서 에러를 던지지 않는다.
  }

  const now = Date.now();
  const seenLinks = new Set<string>();
  const dated: Array<{ item: FeedItem; ts: number }> = [];
  for (const item of rawItems) {
    const ts = parsePubDateMs(item.pubDate);
    if (ts === null) continue; // 날짜를 파싱할 수 없음 — 신뢰할 수 없으므로 제외
    if (now - ts > THIRTY_DAYS_MS) continue; // 30일보다 오래됨 — 제외
    if (seenLinks.has(item.link)) continue; // 링크 기준 중복 제거
    seenLinks.add(item.link);
    dated.push({ item, ts });
  }

  dated.sort((a, b) => b.ts - a.ts);

  return NextResponse.json({ items: dated.slice(0, 20).map((d) => d.item) });
}
