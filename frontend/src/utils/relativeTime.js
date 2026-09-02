/**
 * Timestamps written the way people read a history.
 *
 * A history is scanned, not studied. "2 mins ago" answers "is this still
 * happening"; "Yesterday, 14:32" answers "was this today"; and past that, only
 * the calendar date is worth the space. A full timestamp on every row is
 * technically the most information and practically the least, because every
 * entry looks identical and the eye has to parse each one to find the recent
 * ones.
 *
 * So precision decreases with age, which is the opposite of how the underlying
 * data behaves and exactly how attention behaves.
 *
 * `now` is a parameter rather than a call to `Date.now()` so this is a pure
 * function of its inputs. That is what makes it testable at all - a formatter
 * that reads the clock internally can only be tested by mocking time - and it
 * keeps it safe to call during render.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Parse a timestamp the way the rest of this app stores them.
 *
 * SQLite keeps UTC with no zone marker, so a bare "2026-08-31 09:15:00" is read
 * as local time by the browser and lands hours out. Anything that already
 * carries a zone - which is what Azure returns - is handed over untouched,
 * because appending a Z to an offset produces an invalid date.
 */
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

export function parseWhen(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value);
  const date = HAS_ZONE.test(text)
    ? new Date(text)
    : new Date(`${text.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clockOf(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/**
 * A short, human label for when something happened.
 *
 * Returns an em dash for anything unparseable rather than "Invalid Date" or a
 * silent blank: a row with no time is a fact worth showing, and the raw string
 * "Invalid Date" is not something to put in front of a user.
 */
export function timeAgo(value, now = new Date()) {
  const date = parseWhen(value);
  if (!date) return '—';

  const elapsed = now.getTime() - date.getTime();

  // A clock that is slightly behind the server should not produce "in 3
  // seconds". Anything in the near future reads as just-now, and anything
  // genuinely in the future keeps its date rather than being described
  // relatively, because "-4 days ago" is nonsense.
  if (elapsed < 0) {
    return elapsed > -MINUTE ? 'Just now' : calendarLabel(date, now);
  }

  if (elapsed < MINUTE) return 'Just now';

  if (elapsed < HOUR) {
    const mins = Math.floor(elapsed / MINUTE);
    return `${mins} min${mins === 1 ? '' : 's'} ago`;
  }

  if (sameDay(date, now)) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday, ${clockOf(date)}`;

  return calendarLabel(date, now);
}

/**
 * Month and day, plus the year only when it is not the current one. Repeating
 * "2026" on every row of a history that is mostly this year is noise; omitting
 * it on a row from two years ago is a lie.
 */
export function calendarLabel(date, now = new Date()) {
  const parsed = parseWhen(date);
  if (!parsed) return '—';
  const sameYear = parsed.getFullYear() === now.getFullYear();
  const day = parsed.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${day}, ${clockOf(parsed)}`;
}

/** The full timestamp, for a tooltip on a label that is deliberately vague. */
export function exactWhen(value) {
  const date = parseWhen(value);
  return date ? date.toLocaleString() : '';
}
