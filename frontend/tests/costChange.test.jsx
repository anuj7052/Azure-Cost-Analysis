/**
 * The explanation of a cost movement.
 *
 * Every claim here is arithmetic on returned billing figures. The tests exist
 * mostly to hold the line on what it must *not* say: a missing period is not a
 * zero one, an unnamed remainder is not attributed, and nothing is ever called
 * a cause.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { changeHeadline, explainChange } from '../src/utils/costChange';
import CostChangeExplainer from '../src/components/Charts/CostChangeExplainer';

const money = (value) => `USD ${Number(value).toFixed(2)}`;

const day = (total, services, extra = {}) => ({ total, by_service: services, currency: 'USD', ...extra });

describe('explainChange', () => {
  it('names the largest riser and its share of the increase', () => {
    const reading = explainChange(
      day(160, { VM: 100, Storage: 50, Network: 10 }),
      day(100, { VM: 60, Storage: 30, Network: 10 }),
    );
    expect(reading.status).toBe('ok');
    expect(reading.direction).toBe('up');
    expect(reading.delta).toBe(60);
    expect(reading.percent).toBe(60);
    expect(reading.risers.map(r => r.name)).toEqual(['VM', 'Storage']);
    expect(reading.risers[0].share).toBeCloseTo(40 / 60);
    expect(changeHeadline(reading, money)).toContain('VM');
    expect(changeHeadline(reading, money)).toContain('67% of the increase');
  });

  it('reports offsetting movement rather than only the net figure', () => {
    const reading = explainChange(day(105, { VM: 100, Old: 5 }), day(100, { VM: 40, Old: 60 }));
    expect(reading.grossUp).toBe(60);
    expect(reading.grossDown).toBe(55);
    expect(changeHeadline(reading, money)).toContain('USD 55.00 of falls elsewhere offset part of it');
  });

  it('separates services that started billing from ones that merely grew', () => {
    const reading = explainChange(day(30, { New: 20, VM: 10 }), day(10, { VM: 10 }));
    expect(reading.started).toEqual(['New']);
    expect(reading.stopped).toEqual([]);
  });

  it('separates services that stopped billing from ones that merely shrank', () => {
    const reading = explainChange(day(10, { VM: 10 }), day(30, { Gone: 20, VM: 10 }));
    expect(reading.stopped).toEqual(['Gone']);
    expect(reading.direction).toBe('down');
  });

  it('refuses to attribute anything when a breakdown is missing', () => {
    const reading = explainChange(day(30, null), day(10, { VM: 10 }));
    expect(reading.attributed).toBe(false);
    expect(reading.started).toEqual([]);
    expect(reading.notes.join(' ')).toContain('no service breakdown');
  });

  it('treats a missing prior period as unknown, never as zero', () => {
    const reading = explainChange(day(30, { VM: 30 }), undefined, { priorLabel: '2026-07' });
    expect(reading.status).toBe('no-prior');
    expect(reading.delta).toBeNull();
    expect(reading.notes[0]).toContain('not read as zero');
  });

  it('says nothing at all when the current period was not returned', () => {
    expect(explainChange(null, day(10, { VM: 10 })).status).toBe('missing');
  });

  it('will not subtract two currencies', () => {
    const reading = explainChange(day(30, { VM: 30 }), { total: 10, by_service: { VM: 10 }, currency: 'EUR' });
    expect(reading.status).toBe('incomparable');
    expect(reading.notes[0]).toContain('cannot be subtracted');
  });

  it('surfaces the part of the change no service accounts for', () => {
    const reading = explainChange(day(150, { VM: 60 }), day(100, { VM: 50 }));
    expect(reading.residual).toBe(40);
    expect(reading.residualShare).toBeCloseTo(0.8);
  });

  it('warns that a part-period fall is not yet a saving', () => {
    const reading = explainChange(day(5, { VM: 5 }), day(30, { VM: 30 }), { label: 'today', partial: true });
    expect(reading.notes[0]).toContain('still being billed');
  });

  it('reads a flat total as flat even when services moved under it', () => {
    const reading = explainChange(day(100, { A: 90, B: 10 }), day(100, { A: 10, B: 90 }));
    expect(reading.direction).toBe('flat');
    expect(changeHeadline(reading, money)).toContain('offset each other');
  });

  it('works on monthly rows, which name their total differently', () => {
    const reading = explainChange(
      { total_cost: 20, by_service: { VM: 20 }, currency: 'USD' },
      { total_cost: 10, by_service: { VM: 10 }, currency: 'USD' },
      { totalKey: 'total_cost' },
    );
    expect(reading.delta).toBe(10);
  });
});

describe('CostChangeExplainer', () => {
  const render = (props) => renderToStaticMarkup(
    <CostChangeExplainer label="2026-08-02" priorLabel="2026-08-01" currency="USD" {...props} />,
  );

  it('leads with the movement, its drivers and the caveat', () => {
    const html = render({ current: day(160, { VM: 100, Storage: 60 }), prior: day(100, { VM: 60, Storage: 40 }) });
    expect(html).toContain('+USD 60.00');
    expect(html).toContain('Pushed the bill up');
    expect(html).toContain('VM');
    expect(html).toContain('do not identify the operational cause');
  });

  it('never claims a cause for a period it has no baseline for', () => {
    const html = render({ current: day(160, { VM: 160 }) });
    expect(html).toContain('cannot be shown');
    expect(html).not.toContain('Pushed the bill up');
  });
});
