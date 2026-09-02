/**
 * Explaining a day and explaining a month.
 *
 * The risk in both is the same: a figure that reads as a measurement when it is
 * really an absence. A day with nothing before it has not stayed flat, and a
 * single month has not failed to change. Both must come back as null, because
 * on a page about variance a null and a zero look identical and mean opposite
 * things.
 */
import { describe, expect, it } from 'vitest';

import { dayDetail, dayTimeline, monthsOf, movement, serviceDetail } from '../src/utils/boqTrend';
import { bucketFor } from '../src/utils/boqCompare';

const day = (date, total, by_service) => ({ date, total, by_service });

const DAYS = [
  day('2026-07-01', 100, { Storage: 60, 'Virtual Machines': 40 }),
  day('2026-07-02', 110, { Storage: 60, 'Virtual Machines': 50 }),
  day('2026-07-03', 400, { Storage: 60, 'Virtual Machines': 50, Bandwidth: 290 }),
  day('2026-07-04', 105, { Storage: 55, 'Virtual Machines': 50 }),
];

describe('one day, explained', () => {
  it('lists every service charged, not a top few', () => {
    const d = dayDetail(DAYS, '2026-07-03');
    expect(d.services.map(s => s.name).sort())
      .toEqual(['Bandwidth', 'Storage', 'Virtual Machines']);
  });

  it('compares against the day before, not the period average', () => {
    const d = dayDetail(DAYS, '2026-07-03');
    expect(d.previousDate).toBe('2026-07-02');
    expect(d.change).toBe(290);
    expect(d.changePct).toBeCloseTo(263.64, 1);
  });

  it('names the service that was not there yesterday', () => {
    const d = dayDetail(DAYS, '2026-07-03');
    const bandwidth = d.services.find(s => s.name === 'Bandwidth');
    expect(bandwidth.isNew).toBe(true);
    expect(bandwidth.was).toBeNull();
    expect(d.movers[0].name).toBe('Bandwidth');
  });

  it('keeps a service that stopped, because it explains a fall', () => {
    const d = dayDetail(DAYS, '2026-07-04');
    const gone = d.services.find(s => s.name === 'Bandwidth');
    expect(gone.stopped).toBe(true);
    expect(gone.delta).toBe(-290);
    expect(gone.cost).toBe(0);
  });

  it('reports the first day as having nothing to compare with', () => {
    const d = dayDetail(DAYS, '2026-07-01');
    expect(d.previousDate).toBeNull();
    expect(d.change).toBeNull();
    expect(d.changePct).toBeNull();
    // Not "unchanged" — every delta is unknown, not zero.
    expect(d.services.every(s => s.delta === null)).toBe(true);
  });

  it('shares add up to the day', () => {
    const d = dayDetail(DAYS, '2026-07-03');
    const total = d.services.reduce((s, x) => s + x.share, 0);
    expect(total).toBeCloseTo(100, 0);
  });

  it('says whether the day went over the BOQ share', () => {
    expect(dayDetail(DAYS, '2026-07-03', 200).overBudget).toBe(true);
    expect(dayDetail(DAYS, '2026-07-02', 200).overBudget).toBe(false);
    expect(dayDetail(DAYS, '2026-07-02').overBudget).toBeNull();
  });

  it('returns nothing for a day that is not in the series', () => {
    expect(dayDetail(DAYS, '2026-07-09')).toBeNull();
  });
});

describe('the period as a timeline', () => {
  it('keeps only the days that moved', () => {
    const events = dayTimeline(DAYS);
    expect(events.map(e => e.date)).toEqual(['2026-07-04', '2026-07-03']);
  });

  it('is newest first, because the recent surprise is the interesting one', () => {
    const events = dayTimeline(DAYS);
    expect(events[0].date > events[1].date).toBe(true);
  });

  it('names what drove the jump', () => {
    const spike = dayTimeline(DAYS).find(e => e.date === '2026-07-03');
    expect(spike.kind).toBe('spike');
    expect(spike.drivers[0]).toEqual({ name: 'Bandwidth', delta: 290 });
  });

  it('gives one entry per day, not one per thing that happened', () => {
    const events = dayTimeline(DAYS);
    expect(new Set(events.map(e => e.date)).size).toBe(events.length);
  });

  it('scales the threshold to the estate rather than using a fixed amount', () => {
    // The same shape of movement, a thousand times larger, must be reported
    // the same way — and a thousand times smaller must not be.
    const big = DAYS.map(d => ({
      ...d,
      total: d.total * 1000,
      by_service: Object.fromEntries(
        Object.entries(d.by_service).map(([k, v]) => [k, v * 1000]),
      ),
    }));
    expect(dayTimeline(big).map(e => e.kind)).toEqual(dayTimeline(DAYS).map(e => e.kind));
  });

  it('says nothing when nothing happened', () => {
    const flat = [
      day('2026-07-01', 100, { Storage: 100 }),
      day('2026-07-02', 101, { Storage: 101 }),
      day('2026-07-03', 100, { Storage: 100 }),
    ];
    expect(dayTimeline(flat)).toEqual([]);
  });

  it('needs two days before it can say anything at all', () => {
    expect(dayTimeline([DAYS[0]])).toEqual([]);
  });
});

describe('why the month changed', () => {
  const ROWS = [
    { month: '2026-06', service: 'Storage', cost: 1000 },
    { month: '2026-06', service: 'Virtual Machines', cost: 2000 },
    { month: '2026-07', service: 'Storage', cost: 1500 },
    { month: '2026-07', service: 'Virtual Machines', cost: 1800 },
    { month: '2026-07', service: 'Bandwidth', cost: 700 },
  ];
  const REPORT = {
    budgetFactor: 1,
    categories: [
      { key: 'storage', budgeted: 1200 },
      { key: 'compute', budgeted: 2500 },
    ],
  };

  it('compares the last two months', () => {
    const m = movement(ROWS, bucketFor, REPORT);
    expect(m.from).toBe('2026-06');
    expect(m.to).toBe('2026-07');
    expect(m.fromTotal).toBe(3000);
    expect(m.toTotal).toBe(4000);
    expect(m.delta).toBe(1000);
  });

  it('says nothing rather than zero with one month', () => {
    expect(movement(ROWS.filter(r => r.month === '2026-07'), bucketFor, REPORT)).toBeNull();
  });

  it('separates what rose from what fell', () => {
    const m = movement(ROWS, bucketFor, REPORT);
    expect(m.rose.map(c => c.key)).toContain('storage');
    expect(m.fell.map(c => c.key)).toContain('compute');
  });

  it('says whether the move crossed the BOQ line', () => {
    const m = movement(ROWS, bucketFor, REPORT);
    // Storage was under 1,200 in June and over it in July.
    expect(m.categories.find(c => c.key === 'storage').verdict).toBe('now-over');
    // Compute was under budget and fell further.
    expect(m.categories.find(c => c.key === 'compute').verdict).toBe('under');
    // Bandwidth has no BOQ line at all, which is a different problem.
    expect(m.categories.find(c => c.key === 'bandwidth').verdict).toBe('unbudgeted');
  });

  it('reads the budget as one month whatever basis the report was built on', () => {
    // A whole-period report holds three months of budget; a month-to-month
    // change can only be judged against one of them.
    const scaled = { budgetFactor: 3, categories: [{ key: 'storage', budgeted: 3600 }] };
    const m = movement(ROWS, bucketFor, scaled);
    expect(m.categories.find(c => c.key === 'storage').budgeted).toBe(1200);
  });

  it('names the services behind each category move', () => {
    const m = movement(ROWS, bucketFor, REPORT);
    const storage = m.categories.find(c => c.key === 'storage');
    expect(storage.services[0]).toEqual({
      name: 'Storage', from: 1000, to: 1500, delta: 500,
    });
  });

  it('drops categories that did not really move', () => {
    const steady = [
      { month: '2026-06', service: 'Storage', cost: 1000 },
      { month: '2026-07', service: 'Storage', cost: 1000 },
    ];
    expect(movement(steady, bucketFor, REPORT).categories).toEqual([]);
  });

  it('ignores months either side of the two being compared', () => {
    const m = movement([{ month: '2026-01', service: 'Storage', cost: 99999 }, ...ROWS],
      bucketFor, REPORT);
    expect(m.from).toBe('2026-06');
    expect(m.fromTotal).toBe(3000);
  });

  it('compares any two months that are named', () => {
    const wide = [{ month: '2026-01', service: 'Storage', cost: 400 }, ...ROWS];
    const m = movement(wide, bucketFor, REPORT, { from: '2026-01', to: '2026-07' });
    expect(m.from).toBe('2026-01');
    expect(m.fromTotal).toBe(400);
    expect(m.toTotal).toBe(4000);
  });

  it('reads the pair in time order however it was chosen', () => {
    const back = movement(ROWS, bucketFor, REPORT, { from: '2026-07', to: '2026-06' });
    expect(back.from).toBe('2026-06');
    expect(back.to).toBe('2026-07');
    expect(back.delta).toBe(1000);
  });

  it('refuses to compare a month with itself', () => {
    // Otherwise the panel would report a confident zero, which reads as a
    // measurement rather than as a question that was never asked.
    const m = movement(ROWS, bucketFor, REPORT, { from: '2026-07', to: '2026-07' });
    expect(m.from).not.toBe(m.to);
  });

  it('falls back to the recent pair when a named month is not in the data', () => {
    const m = movement(ROWS, bucketFor, REPORT, { from: '2025-01', to: '2026-07' });
    expect(m.from).toBe('2026-06');
  });

  it('offers every month present so the page need not scan the rows again', () => {
    const wide = [{ month: '2026-01', service: 'Storage', cost: 400 }, ...ROWS];
    expect(movement(wide, bucketFor, REPORT).months).toEqual(['2026-01', '2026-06', '2026-07']);
    expect(monthsOf(wide)).toEqual(['2026-01', '2026-06', '2026-07']);
  });
});

/**
 * One service across the period.
 *
 * The trap here is the days on which a service was not billed. Dropping them
 * makes a service billed nine times in ninety days look identical to one billed
 * every day, and it is the difference between a run rate and a rounding error.
 */
describe('one service, followed', () => {
  const SERIES = [
    day('2026-07-01', 100, { Storage: 60, Bandwidth: 40 }),
    day('2026-07-02', 60, { Storage: 60 }),
    day('2026-07-03', 60, { Storage: 60 }),
    day('2026-07-04', 460, { Storage: 60, Bandwidth: 400 }),
    day('2026-07-05', 80, { Storage: 60, Bandwidth: 20 }),
  ];

  it('keeps the days it was not billed on, as zero', () => {
    const s = serviceDetail(SERIES, 'Bandwidth');
    expect(s.points).toHaveLength(5);
    expect(s.points.map(p => p.cost)).toEqual([40, 0, 0, 400, 20]);
  });

  it('averages over the days it was actually billed, not the whole period', () => {
    const s = serviceDetail(SERIES, 'Bandwidth');
    // 460 over three billed days, not over five.
    expect(s.daysBilled).toBe(3);
    expect(s.daysInPeriod).toBe(5);
    expect(s.average).toBeCloseTo(460 / 3, 2);
  });

  it('names the run of days it went quiet', () => {
    const s = serviceDetail(SERIES, 'Bandwidth');
    expect(s.gaps).toEqual([{ from: '2026-07-02', to: '2026-07-03', days: 2 }]);
  });

  it('does not count days before it started as a gap', () => {
    const late = [
      day('2026-07-01', 60, { Storage: 60 }),
      day('2026-07-02', 60, { Storage: 60 }),
      day('2026-07-03', 100, { Storage: 60, Bandwidth: 40 }),
    ];
    expect(serviceDetail(late, 'Bandwidth').gaps).toEqual([]);
    expect(serviceDetail(late, 'Bandwidth').first).toBe('2026-07-03');
  });

  it('says a service billed every day was billed every day', () => {
    const s = serviceDetail(SERIES, 'Storage');
    expect(s.everyDay).toBe(true);
    expect(s.gaps).toEqual([]);
  });

  it('gives the peak its share of the day, which is what explains a spike', () => {
    const s = serviceDetail(SERIES, 'Bandwidth');
    expect(s.peak).toMatchObject({ date: '2026-07-04', cost: 400 });
    expect(s.peakShare).toBeCloseTo((400 / 460) * 100, 1);
  });

  it('reports its share of everything charged in the period', () => {
    const s = serviceDetail(SERIES, 'Bandwidth');
    expect(s.total).toBe(460);
    expect(s.share).toBeCloseTo((460 / 760) * 100, 1);
  });

  it('compares the second half with the first rather than fitting a line', () => {
    const s = serviceDetail(SERIES, 'Bandwidth');
    // First two days 40, last three 420.
    expect(s.drift).toBe(380);
    expect(s.driftPct).toBeCloseTo(950, 0);
  });

  it('ranks its own biggest day-to-day moves', () => {
    const s = serviceDetail(SERIES, 'Bandwidth');
    expect(s.moves[0]).toMatchObject({ date: '2026-07-04', from: 0, to: 400, delta: 400 });
    expect(s.moves[1]).toMatchObject({ date: '2026-07-05', delta: -380 });
  });

  it('returns nothing for a service that was never charged', () => {
    expect(serviceDetail(SERIES, 'Kubernetes')).toBeNull();
    expect(serviceDetail(SERIES, null)).toBeNull();
    expect(serviceDetail([], 'Storage')).toBeNull();
  });
});
