import { describe, it, expect } from 'vitest';
import {
  VIEW_KEYS, VIEW_LABEL, VIEW_BLURB, viewFromParams,
} from '../src/utils/accessIdentity';

const params = (search) => new URLSearchParams(search);

describe('which Access & Identity view a URL asks for', () => {
  it('reads the view it was given', () => {
    expect(viewFromParams(params('view=assignments'))).toBe('assignments');
    expect(viewFromParams(params('view=optimization'))).toBe('optimization');
  });

  it('ignores case, because links get retyped by hand', () => {
    expect(viewFromParams(params('view=Assignments'))).toBe('assignments');
  });

  it('falls back to the first view rather than rendering nothing', () => {
    // A stale bookmark or a typo should land somewhere useful. Returning
    // undefined here would render a blank page and look like a broken app.
    expect(viewFromParams(params('view=rbac'))).toBe('optimization');
    expect(viewFromParams(params(''))).toBe('optimization');
  });

  it('survives being handed nothing at all', () => {
    expect(viewFromParams(undefined)).toBe('optimization');
    expect(viewFromParams({})).toBe('optimization');
  });

  it('keeps other query parameters out of the decision', () => {
    // `?principal=` arrives from a finding link and must not be mistaken for
    // a view selector.
    expect(viewFromParams(params('principal=abc&view=assignments'))).toBe('assignments');
  });
});

describe('the view list', () => {
  it('names both of the pages that were merged', () => {
    expect(VIEW_KEYS).toEqual(['optimization', 'assignments']);
    expect(VIEW_LABEL.optimization).toBe('Access Optimization');
    expect(VIEW_LABEL.assignments).toBe('Role Assignments');
  });

  it('describes every view, so no tab is unlabelled on hover', () => {
    for (const key of VIEW_KEYS) {
      expect(VIEW_LABEL[key]).toBeTruthy();
      expect(VIEW_BLURB[key]).toBeTruthy();
    }
  });
});
