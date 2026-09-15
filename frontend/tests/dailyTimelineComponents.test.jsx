import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import CostDeltaDetails from '../src/components/Charts/CostDeltaDetails';
import CostDailyTimeline from '../src/components/Charts/CostDailyTimeline';
import { fetchDailyCosts } from '../src/api/client';

vi.mock('../src/api/client', () => ({ fetchDailyCosts: vi.fn() }));
vi.mock('../src/store/useAppStore', () => ({ useAppStore: () => ({ selectedTenantId: 't', selectedSubscriptionIds: ['s'], months: 3 }) }));
vi.mock('../src/store/useTheme', () => ({ useChartTheme: () => ({ series: ['blue'] }) }));
vi.mock('../src/utils/persistCache', () => ({ readCache: () => null, writeCache: () => {} }));

describe('daily timeline rendered states (no DOM test environment)', () => {
  it('renders an explicit block for unsupported filters without querying', () => {
    const html = renderToStaticMarkup(<CostDailyTimeline filters={{ location: 'eastus' }} />);
    expect(html).toContain('Clear those filters or use Monthly');
    expect(fetchDailyCosts).not.toHaveBeenCalled();
  });
  it('renders loading rather than a zero before the client effect runs', () => {
    expect(renderToStaticMarkup(<CostDailyTimeline filters={{}} />)).toContain('Loading daily costs');
  });
  it('opens on the last answer it was given rather than a skeleton', async () => {
    // Cached figures are shown immediately; the request still goes out to
    // check them, which is what the store does for every other query.
    vi.resetModules();
    vi.doMock('../src/utils/persistCache', () => ({
      readCache: () => ({ value: { currency: 'USD', days: [{ date: '2026-08-01', total: 12, by_service: { VM: 12 } }] }, fresh: false }),
      writeCache: () => {},
    }));
    const { default: Cached } = await import('../src/components/Charts/CostDailyTimeline');
    const html = renderToStaticMarkup(<Cached filters={{}} />);
    expect(html).not.toContain('Loading daily costs');
    expect(html).toContain('2026-08-01');
    vi.doUnmock('../src/utils/persistCache');
    vi.resetModules();
  });

  it('renders missing dates separately from a returned zero', () => {
    expect(renderToStaticMarkup(<CostDeltaDetails label="2026-09-14" currency="USD" />)).toContain('A missing date is not a zero-cost date');
    const html = renderToStaticMarkup(<CostDeltaDetails current={{ total: 0, by_service: {} }} label="2026-09-14" priorLabel="2026-09-13" currency="USD" />);
    expect(html).toContain('Previous calendar period unavailable');
    expect(html).toContain('USD 0.00');
  });
  it('shows both disappeared and new services and avoids root-cause claims', () => {
    const html = renderToStaticMarkup(<CostDeltaDetails current={{ total: 20, by_service: { New: 20 } }} prior={{ total: 10, by_service: { Old: 10 } }} label="2026-09-14" priorLabel="2026-09-13" currency="USD" />);
    expect(html).toContain('Old');
    expect(html).toContain('New');
    expect(html).toContain('not operational root causes');
    expect(html).toContain('+USD 20.00');
  });
});