// "YYYY-MM-DD" → "M.D" (0으로 패딩된 부분을 제거)
export function formatMonthDay(dateStr: string): string {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}.${Number(d)}`;
}
