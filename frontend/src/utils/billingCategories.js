export const BILLING_CATEGORIES = [
  { key: 'payg', label: 'Pay-as-you-go', description: 'Actual charges Azure identifies as OnDemand. This means on-demand billing, not necessarily public list prices.' },
  { key: 'ri', label: 'RI', description: 'Actual charges Azure identifies as Reservation, including purchase or adjustment charges returned for this scope. Covered usage can have zero actual cost; this is not amortized cost or a utilization report.' },
  { key: 'asr', label: 'DR / ASR', description: 'Explicit Azure Site Recovery service and meter charges. These may also be PAYG or RI, so the three views must not be added together. DR VMs, disks, backup and networking are not inferred from their names.' },
];

export function billingCategory(value) {
  return BILLING_CATEGORIES.find(item => item.key === value) || BILLING_CATEGORIES[0];
}

export function billingCategoryUrl(category = 'payg') {
  return `/explorer?tab=billing&category=${billingCategory(category).key}`;
}
