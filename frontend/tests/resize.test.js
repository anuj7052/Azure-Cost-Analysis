import { describe, expect, it } from 'vitest';
import {
  NOT_RETURNED,
  UNAVAILABLE,
  actionLabel,
  blockersOf,
  confidenceAdvice,
  confirmDisabled,
  describeOption,
  displayFact,
  displayMoney,
  downtimeFor,
  filterOptions,
  historySummary,
  isResizable,
  isReviewable,
  opensOnPicker,
  optionsSummary,
  outcomeOf,
  savingSummary,
  shouldPoll,
  sortOptions,
  stepsOf,
  targetSkuOf,
} from '../src/utils/resize';

/**
 * The resize is the one action in this application that stops a customer's
 * machine. These tests are about the brakes, not the engine: when the button
 * is offered, when it is enabled, and what a finished operation is allowed to
 * claim.
 */

const runningVm = {
  id: '/subscriptions/s/resourceGroups/g/providers/Microsoft.Compute/virtualMachines/vm',
  name: 'abhinav-vm',
  sku: 'Standard_D8as_v5',
  power_state: 'running',
  right_sizing: { recommendation: 'Standard_D4as_v5', confidence: 'HIGH' },
};

const vm = (over) => ({ ...runningVm, ...over });

describe('when a row may offer a resize', () => {
  it('offers one for a confident recommendation on a running VM', () => {
    expect(isResizable(runningVm)).toBe(true);
    expect(actionLabel(runningVm)).toBe('Review Resize');
  });

  it('offers no recommendation to accept when there is no target size', () => {
    // The verdict alone is not an action, so the button stops claiming to be
    // one. It still opens — onto the size catalogue, where the user picks.
    const advisory = vm({ right_sizing: { confidence: 'HIGH' } });
    expect(isResizable(advisory)).toBe(false);
    expect(actionLabel(advisory)).toBe('Review size');
    expect(opensOnPicker(advisory)).toBe(true);
  });

  it('still offers the review on MEDIUM confidence, because the review is read-only', () => {
    // This used to require HIGH, and the live fleet had none. Every row read
    // "Oversized · MEDIUM · Resize → D4as_v5" beside a button that said "View
    // details" — the page named an action and refused to open it.
    expect(isResizable(vm({
      right_sizing: { recommendation: 'Standard_D4as_v5', confidence: 'MEDIUM' },
    }))).toBe(true);
  });

  it('still offers the review on LOW confidence, and says so inside', () => {
    const low = vm({
      right_sizing: { recommendation: 'Standard_D4as_v5', confidence: 'LOW' },
    });
    expect(isResizable(low)).toBe(true);
    expect(confidenceAdvice(low).text).toContain('investigate');
  });

  it('refuses on a deallocated VM, which is not paying for compute anyway', () => {
    expect(isResizable(vm({ power_state: 'deallocated' }))).toBe(false);
  });

  it('refuses when the recommendation is the size it already is', () => {
    expect(isResizable(vm({
      right_sizing: { recommendation: 'standard_d8as_v5', confidence: 'HIGH' },
    }))).toBe(false);
  });

  it('never says "Resize VM", which would overstate what the button does', () => {
    expect(actionLabel(runningVm)).not.toBe('Resize VM');
  });

  it('survives a row with no right-sizing block at all', () => {
    expect(isResizable({ name: 'x', power_state: 'running' })).toBe(false);
    expect(isResizable(undefined)).toBe(false);
  });

  it('reads the target size the review will propose', () => {
    expect(targetSkuOf(runningVm)).toBe('Standard_D4as_v5');
    expect(targetSkuOf({ recommended_sku: 'Standard_B2s' })).toBe('Standard_B2s');
    expect(targetSkuOf({})).toBe('');
  });
});

describe('infrastructure facts do not become telemetry confidence', () => {
  it('rates a partial telemetry window as MEDIUM and names the caveat', () => {
    const advice = confidenceAdvice(vm({
      right_sizing: { recommendation: 'Standard_D4as_v5', confidence: 'MEDIUM' },
    }));
    expect(advice.level).toBe('MEDIUM');
    expect(advice.tone).not.toBe('good');
    expect(advice.text).toContain('partial telemetry');
  });

  it('does not upgrade that caveat because quota happens to be free', () => {
    // Quota, region availability and permissions are checked by the backend
    // preview. None of them are evidence that the VM was measured for long
    // enough, so none of them may change what confidence says.
    const advice = confidenceAdvice(vm({
      right_sizing: { recommendation: 'Standard_D4as_v5', confidence: 'MEDIUM' },
      quota: { status: 'available' },
      availability: { status: 'available' },
      permission: { allowed: true },
    }));
    expect(advice.level).toBe('MEDIUM');
    expect(advice.tone).not.toBe('good');
  });

  it('says plainly when Azure rated nothing at all', () => {
    const advice = confidenceAdvice(vm({ right_sizing: { recommendation: 'x' } }));
    expect(advice.level).toBeNull();
    expect(advice.text).toContain('not return enough telemetry');
  });
});

describe('the confirm button', () => {
  const plan = { can_resize: true, blockers: [] };

  it('is disabled before the preview has arrived', () => {
    expect(confirmDisabled({ plan: null, acknowledged: true })).toBe(true);
  });

  it('is disabled until the acknowledgement is ticked', () => {
    expect(confirmDisabled({ plan, acknowledged: false })).toBe(true);
    expect(confirmDisabled({ plan, acknowledged: true })).toBe(false);
  });

  it('is disabled when the backend blocked the resize, however keen the user', () => {
    const blocked = { can_resize: false, blockers: ['You do not have permission.'] };
    expect(confirmDisabled({ plan: blocked, acknowledged: true })).toBe(true);
  });

  it('is disabled while the start request is in flight, so a double click cannot start two resizes', () => {
    expect(confirmDisabled({ plan, acknowledged: true, starting: true })).toBe(true);
  });

  it('is disabled once an operation exists, for the same reason', () => {
    expect(confirmDisabled({
      plan, acknowledged: true, operation: { operation_id: 'abc' },
    })).toBe(true);
  });

  it('shows the backend reasons and never invents one', () => {
    const blocked = {
      can_resize: false,
      blockers: ['Quota is insufficient.', 'A resize is already running on this VM.'],
    };
    expect(blockersOf(blocked)).toEqual([
      'Quota is insufficient.',
      'A resize is already running on this VM.',
    ]);
    expect(blockersOf(plan)).toEqual([]);
    expect(blockersOf(null)).toEqual([]);
  });
});

describe('money and facts that Azure did not return', () => {
  it('names a missing price rather than showing zero', () => {
    expect(displayMoney(null, 'INR')).toBe(UNAVAILABLE);
    expect(displayMoney(undefined, 'INR')).toBe(UNAVAILABLE);
    expect(displayMoney(NaN, 'INR')).toBe(UNAVAILABLE);
  });

  it('shows a real zero as a real zero', () => {
    expect(displayMoney(0, 'USD')).not.toBe(UNAVAILABLE);
  });

  it('formats a known amount', () => {
    expect(displayMoney(2650.76, 'INR')).toContain('2,650');
  });

  it('names a capability Azure omitted', () => {
    expect(displayFact(null)).toBe(NOT_RETURNED);
    expect(displayFact('')).toBe(NOT_RETURNED);
    expect(displayFact(8, ' vCPU')).toBe('8 vCPU');
    expect(displayFact(0, ' GiB')).toBe('0 GiB');
  });
});

describe('the saving summary', () => {
  it('states the arithmetic so nobody has to trust an unreproducible number', () => {
    const s = savingSummary({
      currency: 'INR', monthly_saving: 2600, annual_saving: 31200,
    });
    expect(s.known).toBe(true);
    expect(s.arithmetic).toContain('× 12 =');
    expect(s.arithmetic).toContain('2,600');
    expect(s.arithmetic).toContain('31,200');
  });

  it('refuses to claim a saving when Azure had no rate', () => {
    const s = savingSummary({
      currency: 'INR',
      monthly_saving: null,
      annual_saving: null,
      basis: 'price_unavailable',
      note: 'Azure Retail Prices did not return a rate for these sizes.',
    });
    expect(s.known).toBe(false);
    expect(s.monthly).toBe(UNAVAILABLE);
    expect(s.annual).toBe(UNAVAILABLE);
    expect(s.arithmetic).toBe('Azure Retail Prices did not return a rate for these sizes.');
  });

  it('handles no pricing block at all', () => {
    expect(savingSummary(undefined).known).toBe(false);
  });
});

describe('progress', () => {
  const steps = [
    { key: 'stop', label: 'Stop VM', status: 'done' },
    { key: 'resize', label: 'Change VM size', status: 'active' },
    { key: 'start', label: 'Start VM', status: 'pending' },
  ];

  it('reports exactly the steps the backend recorded', () => {
    const view = stepsOf({ steps });
    expect(view.map(s => s.key)).toEqual(['stop', 'resize', 'start']);
    expect(view[0].done).toBe(true);
    expect(view[1].active).toBe(true);
    expect(view[2].done).toBe(false);
    expect(view[2].active).toBe(false);
  });

  it('invents no percentage, because a timed progress bar would be a lie', () => {
    const view = stepsOf({ steps });
    view.forEach((step) => {
      expect(step).not.toHaveProperty('percent');
      expect(step).not.toHaveProperty('progress');
    });
  });

  it('shows nothing rather than guessing when there are no steps yet', () => {
    expect(stepsOf({})).toEqual([]);
    expect(stepsOf(null)).toEqual([]);
  });

  it('keeps polling only while something is genuinely running', () => {
    expect(shouldPoll({ terminal: false })).toBe(true);
    expect(shouldPoll({ terminal: true })).toBe(false);
    expect(shouldPoll(null)).toBe(false);
  });
});

describe('what a finished operation is allowed to claim', () => {
  it('is idle before anything starts', () => {
    expect(outcomeOf(null).kind).toBe('idle');
  });

  it('reports the backend state label while running, not a guess', () => {
    const o = outcomeOf({ terminal: false, state: 'RESIZING', state_label: 'Changing VM size' });
    expect(o.kind).toBe('running');
    expect(o.label).toBe('Changing VM size');
  });

  it('confirms success only when the backend said SUCCESS', () => {
    const o = outcomeOf({
      terminal: true, state: 'SUCCESS', state_label: 'Resize complete',
      old_sku: 'Standard_D8as_v5', new_sku: 'Standard_D4as_v5',
      final_power_state: 'running',
    });
    expect(o.kind).toBe('success');
    expect(o.message).toBe('Azure VM resize completed and the VM is running again.');
  });

  it('reports a plain failure in the backend words', () => {
    const o = outcomeOf({
      terminal: true, state: 'FAILED', state_label: 'Resize failed',
      old_sku: 'Standard_D8as_v5', new_sku: null,
      failure_reason: 'Quota is insufficient for the target size.',
    });
    expect(o.kind).toBe('failure');
    expect(o.message).toBe('Quota is insufficient for the target size.');
    expect(o.needsAttention).toBe(false);
  });

  it('separates the emergency: resized, but the VM never came back up', () => {
    const o = outcomeOf({
      terminal: true, state: 'FAILED', state_label: 'Resize failed',
      old_sku: 'Standard_D8as_v5', new_sku: 'Standard_D4as_v5',
      final_power_state: 'deallocated',
      failure_reason: 'Resize completed, but the VM could not be started.',
    });
    expect(o.kind).toBe('resized_but_stopped');
    expect(o.needsAttention).toBe(true);
  });

  it('does not call a cancelled operation a success', () => {
    const o = outcomeOf({
      terminal: true, state: 'CANCELLED', state_label: 'Cancelled',
      old_sku: 'Standard_D8as_v5', new_sku: null,
    });
    expect(o.kind).not.toBe('success');
  });
});

describe('the audit line', () => {
  it('reads as a change record', () => {
    const line = historySummary({
      vm_name: 'abhinav-vm',
      old_sku: 'Standard_D8as_v5',
      new_sku: 'Standard_D4as_v5',
      state_label: 'Resize complete',
      estimated_monthly_saving: 2600,
      currency: 'INR',
    });
    expect(line).toContain('abhinav-vm');
    expect(line).toContain('Standard_D8as_v5 → Standard_D4as_v5');
    expect(line).toContain('Resize complete');
    expect(line).toContain('2,600');
  });

  it('says the saving is not available rather than printing zero', () => {
    const line = historySummary({
      vm_name: 'vm', old_sku: 'a', new_sku: 'b', state_label: 'Resize failed',
      estimated_monthly_saving: null, currency: 'INR',
    });
    expect(line).toContain('not available');
    expect(line).not.toMatch(/0\/month/);
  });
});

describe('every VM can be reviewed, not just the ones we had an opinion about', () => {
  it('opens for a VM the algorithm made no recommendation for', () => {
    const vm = { id: '/subscriptions/s/vm', sku: 'Standard_B2als_v2', power_state: 'running' };
    expect(isResizable(vm)).toBe(false);
    expect(isReviewable(vm)).toBe(true);
    expect(actionLabel(vm)).toBe('Review size');
  });

  it('opens for a deallocated VM, which is the cheapest one to resize', () => {
    const vm = { id: '/subscriptions/s/vm', sku: 'Standard_D4as_v5', power_state: 'deallocated' };
    expect(isReviewable(vm)).toBe(true);
    expect(opensOnPicker(vm)).toBe(true);
  });

  it('still leads with the recommendation when there is one', () => {
    const vm = {
      id: '/subscriptions/s/vm', sku: 'Standard_D4as_v5', power_state: 'running',
      right_sizing: { recommendation: 'Standard_D2as_v5', confidence: 'HIGH' },
    };
    expect(actionLabel(vm)).toBe('Review Resize');
    expect(opensOnPicker(vm)).toBe(false);
  });

  it('cannot review something with no resource id at all', () => {
    expect(isReviewable({})).toBe(false);
  });
});

describe('a stopped VM is told the truth about downtime', () => {
  it('warns a running VM that it will be stopped', () => {
    const d = downtimeFor({ power_state: 'running' });
    expect(d.tone).toBe('high');
    expect(d.text).toContain('unavailable');
  });

  it('does not invent downtime for a machine that is already off', () => {
    const d = downtimeFor({ power_state: 'deallocated' });
    expect(d.title).toContain('No downtime');
    // Starting it would put it back on the bill the owner stopped paying.
    expect(d.text).toContain('will not be started');
  });
});

describe('the size picker never turns a missing number into a cheap machine', () => {
  const base = { name: 'Standard_D2as_v5', vcpu: 2, memory_gb: 8, selectable: true,
                 quota: { status: 'available', label: 'Quota available' },
                 availability: { status: 'available', label: 'Available' } };

  it('says a price is unavailable rather than showing zero', () => {
    const d = describeOption({ ...base, monthly_list_price: null }, 'INR');
    expect(d.price).toBe('Price not available');
  });

  it('says vCPU is not returned rather than showing a machine with no cores', () => {
    const d = describeOption({ ...base, vcpu: null, memory_gb: null }, 'INR');
    expect(d.specs).toContain('vCPU not returned');
    expect(d.specs).toContain('Memory not returned');
  });

  it('reports a bigger size as costing more, not as a negative saving', () => {
    const d = describeOption({ ...base, estimated_monthly_delta: -1500 }, 'INR');
    expect(d.impact.text).toContain('Costs');
    expect(d.impact.text).not.toContain('-');
    expect(d.impact.tone).toBe('high');
  });

  it('reports a smaller size as a saving', () => {
    const d = describeOption({ ...base, estimated_monthly_delta: 3237.59 }, 'INR');
    expect(d.impact.text).toContain('Saves');
    expect(d.impact.tone).toBe('good');
  });

  it('shows the exact figure, not an abbreviation, where money is chosen', () => {
    const d = describeOption({ ...base, monthly_list_price: 10334.03 }, 'INR');
    expect(d.price).toContain('10,334.03');
  });

  it('gives a blocked size a reason instead of a silent grey row', () => {
    const d = describeOption({
      ...base, selectable: false,
      blockers: ['Azure restricts this size in centralindia for this subscription.'],
    }, 'INR');
    expect(d.selectable).toBe(false);
    expect(d.blockers[0]).toContain('restricts');
  });
});

describe('the picker puts the useful sizes first', () => {
  const options = [
    { name: 'C_large', selectable: true, estimated_monthly_delta: -100 },
    { name: 'A_blocked', selectable: false, estimated_monthly_delta: 900 },
    { name: 'B_saves', selectable: true, estimated_monthly_delta: 500 },
    { name: 'D_current', selectable: false, is_current: true },
    { name: 'E_rec', selectable: true, is_recommended: true, estimated_monthly_delta: 300 },
  ];

  it('leads with the recommendation, then the current size', () => {
    const sorted = sortOptions(options).map(o => o.name);
    expect(sorted[0]).toBe('E_rec');
    expect(sorted[1]).toBe('D_current');
  });

  it('orders the rest by how much they save', () => {
    const rest = sortOptions(options).slice(2).map(o => o.name);
    expect(rest).toEqual(['B_saves', 'C_large', 'A_blocked']);
  });

  it('sinks unusable sizes rather than hiding why they exist', () => {
    expect(sortOptions(options).at(-1).name).toBe('A_blocked');
  });

  it('does not mutate the list it was given', () => {
    const before = options.map(o => o.name);
    sortOptions(options);
    expect(options.map(o => o.name)).toEqual(before);
  });
});

describe('filtering the catalogue', () => {
  const options = [
    { name: 'Standard_D2as_v5', change: 'smaller', selectable: true },
    { name: 'Standard_D8as_v5', change: 'larger', selectable: true },
    { name: 'Standard_E4as_v5', change: 'larger', selectable: false },
    { name: 'Standard_D4as_v5', change: 'same', selectable: false, is_current: true },
  ];

  it('searches by name, case-insensitively', () => {
    expect(filterOptions(options, { search: 'e4as' }).map(o => o.name))
      .toEqual(['Standard_E4as_v5']);
  });

  it('can show only smaller sizes', () => {
    expect(filterOptions(options, { change: 'smaller' }).map(o => o.name))
      .toContain('Standard_D2as_v5');
  });

  it('always keeps the current size visible for comparison', () => {
    const names = filterOptions(options, { change: 'smaller', onlySelectable: true })
      .map(o => o.name);
    expect(names).toContain('Standard_D4as_v5');
  });

  it('can hide sizes this subscription cannot use', () => {
    expect(filterOptions(options, { onlySelectable: true }).map(o => o.name))
      .not.toContain('Standard_E4as_v5');
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(filterOptions(options, { search: 'zzz' })).toEqual([]);
  });
});

describe('the picker header is honest about an empty catalogue', () => {
  it('says Azure returned nothing rather than showing 0 sizes available', () => {
    expect(optionsSummary({ options: [] }).text).toContain('did not return any sizes');
  });

  it('counts what is actually usable, not just what was listed', () => {
    const s = optionsSummary({ options: [
      { selectable: true }, { selectable: false }, { selectable: true },
    ] });
    expect(s.total).toBe(3);
    expect(s.selectable).toBe(2);
  });
});
