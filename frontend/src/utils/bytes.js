// Data-size formatting helpers — Azure bandwidth meters are reported in bytes
// after normalisation, so everything here works from a raw byte count.

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;
const PB = TB * 1024;

export { KB, MB, GB, TB, PB };

/** "1.24 TB" / "812.40 GB" / "45.10 MB" */
export function formatBytes(bytes, digits = 2) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  const n = Math.abs(bytes);
  if (n >= PB) return `${(bytes / PB).toFixed(digits)} PB`;
  if (n >= TB) return `${(bytes / TB).toFixed(digits)} TB`;
  if (n >= GB) return `${(bytes / GB).toFixed(digits)} GB`;
  if (n >= MB) return `${(bytes / MB).toFixed(digits)} MB`;
  if (n >= KB) return `${(bytes / KB).toFixed(digits)} KB`;
  return `${Math.round(bytes)} B`;
}

/** Split into { value, unit } so the UI can style the unit separately. */
export function splitBytes(bytes, digits = 2) {
  const formatted = formatBytes(bytes, digits);
  if (formatted === '—') return { value: '—', unit: '' };
  const [value, unit = ''] = formatted.split(' ');
  return { value, unit };
}

export const toGB = (bytes) => (bytes || 0) / GB;
export const toTB = (bytes) => (bytes || 0) / TB;

/** Always render in GB — useful for tables where units must line up. */
export function formatGB(bytes, digits = 2) {
  if (bytes == null) return '—';
  return `${toGB(bytes).toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} GB`;
}

/** Always render in TB. */
export function formatTB(bytes, digits = 3) {
  if (bytes == null) return '—';
  return `${toTB(bytes).toFixed(digits)} TB`;
}

/** Percentage of a total, guarded against divide-by-zero. */
export function pctOf(part, total) {
  if (!total) return 0;
  return (part / total) * 100;
}
