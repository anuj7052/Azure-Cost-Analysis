import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import ReservationNote from '../src/components/Common/ReservationNote';
import { serviceSlice } from '../src/utils/dailyTimeline';
const period = { reservation_context: { VM: { cost: 5000, purchase_cost: 5000, refund_cost: 0, charge_types: ['Purchase'] } } };
it('explains a confirmed payment spike without claiming increased usage', () => {
  const html = renderToStaticMarkup(<ReservationNote period={period} currency="USD" />);
  expect(html).toContain('RI purchase / payment');
  expect(html).toContain('USD 5,000.00');
  expect(html).toContain('without an equivalent increase');
});
it('does not label ordinary charges or another service as RI', () => {
  expect(renderToStaticMarkup(<ReservationNote period={{ by_service: { RI: 90000 } }} />)).toBe('');
  expect(renderToStaticMarkup(<ReservationNote period={period} service="Storage" />)).toBe('');
  expect(serviceSlice([{ ...period, date: '2026-08-01', by_service: { VM: 5000 } }], 'Storage')[0].reservation_context).toEqual({});
});
it('distinguishes covered usage from a purchase', () => {
  const html = renderToStaticMarkup(<ReservationNote currency="USD" period={{ reservation_context: { VM: { cost: 0, purchase_cost: 0, refund_cost: 0 } } }} />);
  expect(html).toContain('RI reservation pricing');
  expect(html).not.toContain('RI purchase / payment');
});
