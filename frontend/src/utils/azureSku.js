/**
 * Azure SKU decoding.
 *
 * A bill says "P40 LRS Disk" and nothing else — no capacity, no friendly type.
 * Azure managed disk tiers are a fixed published ladder, so the size can be
 * resolved locally instead of sending the user to the portal to look it up.
 */

/** Managed disk tier → provisioned capacity in GiB (same ladder for P/E/S). */
const DISK_TIER_GIB = {
  1: 4, 2: 8, 3: 16, 4: 32, 6: 64, 10: 128, 15: 256, 20: 512,
  30: 1024, 40: 2048, 50: 4096, 60: 8192, 70: 16384, 80: 32767,
};

const DISK_FAMILY = {
  p: 'Premium SSD',
  e: 'Standard SSD',
  s: 'Standard HDD',
};

const DISK_SKU = /\b([PSE])(\d{1,3})\b/i;

/**
 * Decode a disk SKU into its tier, family and provisioned size.
 * Returns null when the text names no recognisable disk SKU.
 */
export function diskSpec(text) {
  const m = String(text || '').match(DISK_SKU);
  if (!m) return null;
  const gib = DISK_TIER_GIB[Number(m[2])];
  if (!gib) return null;
  return {
    sku: `${m[1].toUpperCase()}${m[2]}`,
    family: DISK_FAMILY[m[1].toLowerCase()] || '',
    gib,
    size: gib >= 1024 ? `${gib / 1024} TiB` : `${gib} GiB`,
  };
}

/** Friendly name for an ARM type: "Microsoft.Compute/disks" → "Managed disk". */
const TYPE_NAMES = {
  'microsoft.compute/disks': 'Managed disk',
  'microsoft.compute/virtualmachines': 'Virtual machine',
  'microsoft.compute/snapshots': 'Disk snapshot',
  'microsoft.compute/virtualmachinescalesets': 'VM scale set',
  'microsoft.storage/storageaccounts': 'Storage account',
  'microsoft.network/publicipaddresses': 'Public IP address',
  'microsoft.network/networkinterfaces': 'Network interface',
  'microsoft.network/virtualnetworks': 'Virtual network',
  'microsoft.network/networksecuritygroups': 'Network security group',
  'microsoft.network/loadbalancers': 'Load balancer',
  'microsoft.network/natgateways': 'NAT gateway',
  'microsoft.network/azurefirewalls': 'Azure Firewall',
  'microsoft.network/virtualnetworkgateways': 'VPN gateway',
  'microsoft.recoveryservices/vaults': 'Recovery Services vault',
  'microsoft.operationalinsights/workspaces': 'Log Analytics workspace',
  'microsoft.keyvault/vaults': 'Key vault',
  'microsoft.sql/servers': 'SQL server',
  'microsoft.web/sites': 'App Service',
  'microsoft.web/serverfarms': 'App Service plan',
  'microsoft.containerservice/managedclusters': 'Kubernetes cluster',
  'microsoft.fabric/capacities': 'Fabric capacity',
  'microsoft.powerbidedicated/capacities': 'Power BI capacity',
  'microsoft.cognitiveservices/accounts': 'Azure AI service',
  'microsoft.dbformysql/flexibleservers': 'MySQL flexible server',
  'microsoft.dbforpostgresql/flexibleservers': 'PostgreSQL flexible server',
};

export function friendlyType(resourceType) {
  const key = String(resourceType || '').toLowerCase();
  if (!key) return '';
  if (TYPE_NAMES[key]) return TYPE_NAMES[key];
  // Fall back to the ARM type itself, de-camel-cased: "flexibleServers" → "Flexible servers".
  const tail = key.split('/').pop() || '';
  const original = String(resourceType).split('/').pop() || tail;
  return original
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

/**
 * Pull the readable parts out of a resource id.
 *
 * An ARM id carries the answer to "what was this?" in the middle of it — the
 * provider and type sit between `/providers/` and the resource's own name — but
 * nobody should have to read a hundred-character path to find them. A GUID
 * identifies a subscription to Azure; it identifies nothing at all to the
 * person asking who touched production last Tuesday.
 */
export function describeResourceId(resourceId) {
  if (!resourceId) return { name: '', service: '', resourceGroup: '' };
  const parts = String(resourceId).split('/').filter(Boolean);
  const at = parts.findIndex(p => p.toLowerCase() === 'providers');
  const rgAt = parts.findIndex(p => p.toLowerCase() === 'resourcegroups');

  const name = parts[parts.length - 1] || '';
  const resourceGroup = rgAt === -1 ? '' : (parts[rgAt + 1] || '');
  if (at === -1 || parts.length < at + 3) return { name, service: '', resourceGroup };

  // Nested types read as provider/parentType/name/childType; the child is the
  // one that describes the resource, not the parent it hangs off.
  const namespace = parts[at + 1];
  const tail = parts.slice(at + 2);
  const type = tail.length >= 4 ? tail[2] : tail[0];
  return { name, service: friendlyType(`${namespace}/${type}`), resourceGroup };
}

