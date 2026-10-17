import { describe, expect, it } from 'vitest';
import { noteColor, notesByDate, shiftDay, todayIso } from '../src/utils/costNotes';
import { migrateExplorerView } from '../src/utils/monthCompare';

describe('cost notes helpers', () => {
  it('shifts dates across month and year boundaries without time-zone drift', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDay('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('formats the local date and groups notes by day', () => {
    expect(todayIso(new Date(2026, 9, 6, 23, 30))).toBe('2026-10-06');
    const grouped = notesByDate([{ id: 1, note_date: '2026-10-12' }, { id: 2, note_date: '2026-10-12' }, { id: 3, note_date: '2026-10-13' }]);
    expect(grouped['2026-10-12'].map(n => n.id)).toEqual([1, 2]);
    expect(grouped['2026-10-13']).toHaveLength(1);
  });

  it('falls back to yellow for an unknown colour', () => {
    expect(noteColor('nope').key).toBe('yellow');
  });

  it('keeps the day-details tab when it is linked to', () => {
    expect(migrateExplorerView({ tab: 'day' }).tab).toBe('day');
  });
});
