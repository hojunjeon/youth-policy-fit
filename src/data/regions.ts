// 시/도 (법정동코드 상위 2자리)
export interface Region {
  code: string;
  name: string;
  short: string;
}

export const REGIONS: Region[] = [
  { code: "11", name: "서울특별시", short: "서울" },
  { code: "26", name: "부산광역시", short: "부산" },
  { code: "27", name: "대구광역시", short: "대구" },
  { code: "28", name: "인천광역시", short: "인천" },
  { code: "12", name: "전남광주통합특별시", short: "전남광주" },
  { code: "30", name: "대전광역시", short: "대전" },
  { code: "31", name: "울산광역시", short: "울산" },
  { code: "36", name: "세종특별자치시", short: "세종" },
  { code: "41", name: "경기도", short: "경기" },
  { code: "51", name: "강원특별자치도", short: "강원" },
  { code: "43", name: "충청북도", short: "충북" },
  { code: "44", name: "충청남도", short: "충남" },
  { code: "52", name: "전북특별자치도", short: "전북" },
  { code: "47", name: "경상북도", short: "경북" },
  { code: "48", name: "경상남도", short: "경남" },
  { code: "50", name: "제주특별자치도", short: "제주" },
];

export function regionName(code?: string): string {
  return REGIONS.find((r) => r.code === code)?.short ?? "미입력";
}
