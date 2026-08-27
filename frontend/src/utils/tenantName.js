/**
 * One place that decides what a tenant is called on screen.
 *
 * Azure often hands back a directory whose `tenant_name` is simply its GUID.
 * Printing that is technically accurate and completely useless: a business user
 * reading "Showing 99602a89-c774-49bf-9da7-88879da51dc6" learns nothing, and
 * cannot even tell whether it is the right tenant.
 *
 * The signed-in user's email domain is the one human-readable fact available
 * without another Graph call, so it stands in. It is presented as "My Tenant
 * (foetron.com)" rather than as a directory name, because the domain is a
 * property of the *account*, not of the tenant, and the wording should not
 * claim more than it knows.
 *
 * This lived inline in two places in the top bar. Duplicated naming rules drift,
 * and a page calling the same tenant by a different name than the selector
 * above it is a small bug that destroys a lot of trust.
 */
export function tenantLabel(tenant, username = '') {
  if (!tenant) return 'Select tenant';

  const name = tenant.tenant_name;
  if (!name) return tenant.tenant_id || 'Unknown tenant';

  if (!isGuid(name)) return name;

  const domain = String(username || '').split('@')[1];
  return domain ? `My Tenant (${domain})` : 'My Azure Tenant';
}

const isGuid = (value) => /^[0-9a-f-]{36}$/i.test(String(value || ''));
