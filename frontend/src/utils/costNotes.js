/** Sticky-note colours; fixed hexes so they read the same in light and dark mode. */
export const NOTE_COLORS = [
  { key: 'yellow', label: 'Yellow', bg: '#fef9c3', text: '#713f12', dot: '#eab308' },
  { key: 'orange', label: 'Orange', bg: '#ffedd5', text: '#7c2d12', dot: '#ea580c' },
  { key: 'blue', label: 'Blue', bg: '#dbeafe', text: '#1e3a8a', dot: '#2563eb' },
  { key: 'green', label: 'Green', bg: '#dcfce7', text: '#14532d', dot: '#16a34a' },
  { key: 'pink', label: 'Pink', bg: '#fce7f3', text: '#831843', dot: '#db2777' },
];

export function noteColor(key) {
  return NOTE_COLORS.find(c => c.key === key) || NOTE_COLORS[0];
}

/** Local calendar date as YYYY-MM-DD. */
export function todayIso(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Move a YYYY-MM-DD date by whole days, without time-zone drift. */
export function shiftDay(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Group notes by date: { 'YYYY-MM-DD': [note, …] }. */
export function notesByDate(notes = []) {
  const out = {};
  for (const note of notes) (out[note.note_date] ||= []).push(note);
  return out;
}
