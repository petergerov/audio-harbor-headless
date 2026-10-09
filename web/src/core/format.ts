/** `m:ss` for a position or duration. */
export function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** "1 song", "12 songs". */
export function songs(count: number): string {
  return `${count} song${count === 1 ? '' : 's'}`;
}

/** The capital a placeholder cover shows. */
export function initial(title: string, fallback = '•'): string {
  return (title.trim()[0] ?? fallback).toUpperCase();
}
