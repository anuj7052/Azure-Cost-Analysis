/**
 * How a history labels its timestamps.
 *
 * The rule being protected is that precision decreases with age. The two ways
 * this breaks are both silent: a bare SQLite timestamp read as local time lands
 * hours out, and an unparseable value renders the literal words "Invalid Date"
 * into the page. Neither announces itself, so both are pinned here.
 */
import { describe as group, it, expect } from 'vitest';
import { timeAgo, calendarLabel, parseWhen, exactWhen } from '../src/utils/relativeTime';

const NOW = new Date('2026-08-31T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

group('recent things, in relative terms', () => {
  it('calls the last minute just now', () => {
    expect(timeAgo(ago(5_000), NOW)).toBe('Just now');
  });

  it('counts minutes below an hour', () => {
    expect(timeAgo(ago(2 * MINUTE), NOW)).toBe('2 mins ago');
    expect(timeAgo(ago(59 * MINUTE), NOW)).toBe('59 mins ago');
  });

  it('says one minute in the singular', () => {
    expect(timeAgo(ago(MINUTE), NOW)).toBe('1 min ago');
  });

  it('counts hours for the rest of the same day', () => {
    // Anchored to local midday so that subtracting a few hours cannot cross
    // midnight. Measured from a fixed instant instead, this would assert
    // "3 hours ago" in London and "Yesterday, 23:00" in Honolulu - and the
    // second of those is the correct answer, not a bug.
    const noon = new Date(NOW);
    noon.setHours(12, 0, 0, 0);
    const before = (ms) => new Date(noon.getTime() - ms);

    expect(timeAgo(before(3 * HOUR), noon)).toBe('3 hours ago');
    expect(timeAgo(before(HOUR), noon)).toBe('1 hour ago');
  });
});

group('older things, on the calendar', () => {
  it('names yesterday and keeps the clock', () => {
    // Built by walking back a local calendar day rather than subtracting a
    // fixed number of hours. "22 hours ago" is yesterday in London and still
    // today in Sydney, so an elapsed-time fixture tests the timezone rather
    // than the rule. The rule is about calendar days, because that is how
    // people read a history.
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(14, 32, 0, 0);
    expect(timeAgo(yesterday, NOW)).toBe('Yesterday, 14:32');
  });

  it('falls back to a date once it is older than yesterday', () => {
    // Built from the same instant rather than written out, because "Aug 12"
    // is only Aug 12 in some timezones - the assertion is about the shape of
    // the label, not about where the test happens to run.
    const when = '2026-08-12T09:15:00Z';
    const day = new Date(when).toLocaleDateString([], { month: 'short', day: 'numeric' });
    expect(timeAgo(when, NOW)).toMatch(new RegExp(`^${day}, \\d{2}:\\d{2}$`));
  });

  it('omits the year within the current year and shows it otherwise', () => {
    expect(calendarLabel('2026-08-12T09:15:00Z', NOW)).not.toMatch(/2026/);
    expect(calendarLabel('2024-08-12T09:15:00Z', NOW)).toMatch(/2024/);
  });
});

group('timestamps that would otherwise land hours out', () => {
  it('reads a zoneless SQLite timestamp as UTC, not as local time', () => {
    // The bug this prevents: without the Z, the browser reads stored UTC as
    // local time, and every capture in the app appears hours away from when it
    // actually happened.
    expect(parseWhen('2026-08-31 09:15:00').toISOString()).toBe('2026-08-31T09:15:00.000Z');
  });

  it('leaves a timestamp that already carries a zone alone', () => {
    expect(parseWhen('2026-08-31T09:15:00+05:30').toISOString()).toBe('2026-08-31T03:45:00.000Z');
    expect(parseWhen('2026-08-31T09:15:00Z').toISOString()).toBe('2026-08-31T09:15:00.000Z');
  });

  it('accepts a Date as given', () => {
    expect(parseWhen(NOW)).toBe(NOW);
  });
});

group('refusing to print nonsense', () => {
  it('shows a dash rather than the words Invalid Date', () => {
    for (const bad of [null, undefined, '', 'not a date', new Date('nope')]) {
      expect(timeAgo(bad, NOW)).toBe('—');
      expect(exactWhen(bad)).toBe('');
    }
  });

  it('does not describe a future timestamp as having already happened', () => {
    // A client clock a few seconds behind the server must not produce
    // "in -3 seconds" or, worse, "3 seconds ago" for something yet to occur.
    const soon = new Date(NOW.getTime() + 30_000).toISOString();
    expect(timeAgo(soon, NOW)).toBe('Just now');

    const later = new Date(NOW.getTime() + 5 * 24 * HOUR);
    const day = later.toLocaleDateString([], { month: 'short', day: 'numeric' });
    expect(timeAgo(later.toISOString(), NOW)).toMatch(new RegExp(`^${day},`));
  });
});
