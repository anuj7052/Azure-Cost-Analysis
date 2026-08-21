/**
 * CSV export.
 *
 * An export that opens wrong in Excel is worse than no export: the numbers look
 * plausible while sitting in the wrong columns. These are the cases that cause
 * that.
 */
import { describe, expect, it } from 'vitest';

import { timestampedName, toCsv } from '../src/utils/csv';

describe('toCsv', () => {
  it('joins rows with CRLF, which is what Excel expects', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d');
  });

  it('quotes a value containing a comma', () => {
    // Azure resource names and tag values routinely contain commas. Unquoted,
    // every following column shifts by one.
    expect(toCsv([['Virtual Machines, Linux', '10']]))
      .toBe('"Virtual Machines, Linux",10');
  });

  it('escapes embedded quotes by doubling them', () => {
    expect(toCsv([['say "hi"']])).toBe('"say ""hi"""');
  });

  it('quotes a value containing a newline', () => {
    // A raw newline ends the record early and splits one row into two.
    expect(toCsv([['line1\nline2']])).toBe('"line1\nline2"');
  });

  it('writes an empty cell for a missing value rather than "null"', () => {
    // A blank unit price means "unknown"; the string "null" would be quoted to
    // a customer.
    expect(toCsv([['a', null, undefined, '']])).toBe('a,,,');
  });

  it('leaves ordinary values untouched', () => {
    expect(toCsv([['D2s v3', 'eastus', '100.00']])).toBe('D2s v3,eastus,100.00');
  });
});

describe('timestampedName', () => {
  it('produces a name that sorts chronologically', () => {
    expect(timestampedName('azure-boq')).toMatch(/^azure-boq-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('honours a different extension', () => {
    expect(timestampedName('report', 'txt')).toMatch(/\.txt$/);
  });
});
