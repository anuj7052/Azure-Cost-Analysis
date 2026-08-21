/**
 * CSV export.
 *
 * Written by hand rather than pulled from a library: the whole job is quoting
 * and joining, and a dependency for that is weight the bundle does not need.
 */

/**
 * Quote a value for CSV.
 *
 * Azure resource names and tag values routinely contain commas, and resource
 * ids contain quotes far less often but do occur. Either one unquoted shifts
 * every following column, which is the failure that makes an export unusable
 * in a spreadsheet.
 */
function quote(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(rows) {
  return rows.map(row => row.map(quote).join(',')).join('\r\n');
}

/**
 * Download rows as a CSV file.
 *
 * A UTF-8 byte-order mark is prepended because Excel otherwise reads the file
 * as the local codepage and mangles every non-ASCII character — currency
 * symbols and accented names included, which is most of what a BOQ contains.
 */
export function downloadCsv(rows, fileName) {
  const csv = toCsv(rows);
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Download a blob the server produced.
 *
 * Binary formats are built server-side — writing an .xlsx in the browser means
 * shipping a spreadsheet library to every visitor for a button most never
 * press. The browser's only job is to save what came back.
 */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** A filename that sorts chronologically and says what it contains. */
export function timestampedName(prefix, extension = 'csv') {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${prefix}-${stamp}.${extension}`;
}
