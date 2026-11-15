export function fmtTime(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay ? hm : `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`;
}

export function pct(a: number, b: number): string {
  return b > 0 ? `${Math.round((a / b) * 100)}%` : '-';
}
