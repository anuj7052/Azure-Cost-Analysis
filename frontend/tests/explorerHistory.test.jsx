import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import CostDeltaDetails from '../src/components/Charts/CostDeltaDetails';
import { resourcesInService } from '../src/utils/boqResources';
import { DataTable } from '../src/components/ui';

it('lists all returned services and opens the clicked service', () => {
  const onPickService = vi.fn();
  const props = { current: { total: 15, by_service: { Storage: 10, Network: 5 } }, prior: { total: 12, by_service: { Storage: 12 } }, label: '2026-08-02', priorLabel: '2026-08-01', currency: 'USD', onPickService };
  const html = renderToStaticMarkup(<CostDeltaDetails {...props} />);
  expect(html).toContain('Open Storage service details');
  expect(html).toContain('Open Network service details');
  const table = React.Children.toArray(CostDeltaDetails(props).props.children).find(node => node.type === DataTable);
  table.props.columns[0].render({ name: 'Network' }).props.onClick();
  expect(onPickService).toHaveBeenCalledWith('Network');
});

it('keeps same-named resources in separate subscriptions and carries the ARM id', () => {
  const rows = ['a', 'b'].map(subscription_id => ({ service: 'Storage', month: '2026-08', cost: 10, resource_name: 'disk', resource_group: 'rg', subscription_id, resource_id: `/subscriptions/${subscription_id}/resourceGroups/rg/providers/Microsoft.Compute/disks/disk` }));
  const listing = resourcesInService(rows, 'Storage');
  expect(listing.resources).toHaveLength(2);
  expect(listing.resources[0].resourceId).toBe(rows[0].resource_id);
  expect(listing.resources[1].subscriptionId).toBe('b');
});
