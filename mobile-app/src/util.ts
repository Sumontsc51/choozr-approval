export function fmt(d?: string): string {
  if (!d) return '';
  const x = new Date(d);
  if (isNaN(x.getTime())) return String(d);
  return x.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
