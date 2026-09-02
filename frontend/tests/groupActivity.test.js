/**
 * Turning a diff into a readable history.
 *
 * Two claims are worth protecting here. A history must not quietly drop rows -
 * one that omits ignored changes disagrees with the counts on the rest of the
 * page. And an actor must never be attached to the wrong resource, because the
 * casing of a resource id differs between the two Azure APIs this joins, and
 * getting that wrong is silent in both directions: no actor at all, or somebody
 * else's name against your change.
 */
import { describe as group, it, expect } from 'vitest';
import {
  buildGroupTimeline, attachActors, eventKindOf, isTagOnly, titleOf,
} from '../src/utils/groupActivity';

const RG = '/subscriptions/sub-123/resourceGroups/rg-prod-westus-001';

const resource = (over = {}) => ({
  resource_id: `${RG}/providers/Microsoft.Compute/virtualMachines/vm-web-prod-02`,
  name: 'vm-web-prod-02',
  type: 'Microsoft.Compute/virtualMachines',
  resource_group: 'rg-prod-westus-001',
  kind: 'modified',
  changes: [],
  tags: {},
  ignored: false,
  ...over,
});

group('deciding what kind of event a change is', () => {
  it('reads an added resource as a creation and a removed one as a deletion', () => {
    expect(eventKindOf(resource({ kind: 'added' }))).toBe('created');
    expect(eventKindOf(resource({ kind: 'removed' }))).toBe('deleted');
  });

  it('separates a tag edit from a real configuration change', () => {
    const tagged = resource({ changes: [{ field: 'tags.Environment' }] });
    const resized = resource({ changes: [{ field: 'sku' }] });
    expect(eventKindOf(tagged)).toBe('tagged');
    expect(eventKindOf(resized)).toBe('modified');
  });

  it('does not call a mixed change a tag edit', () => {
    // The risk is burying a resize among bookkeeping. One non-tag field is
    // enough to make this a configuration change.
    const mixed = resource({ changes: [{ field: 'tags.Owner' }, { field: 'sku' }] });
    expect(isTagOnly(mixed)).toBe(false);
    expect(eventKindOf(mixed)).toBe('modified');
  });
});

group('the history itself', () => {
  it('puts things appearing and disappearing above details moving', () => {
    const timeline = buildGroupTimeline([
      resource({ name: 'b-modified', kind: 'modified', changes: [{ field: 'sku' }] }),
      resource({ name: 'a-deleted', kind: 'removed' }),
      resource({ name: 'c-created', kind: 'added' }),
    ]);
    expect(timeline.map((e) => e.eventKind)).toEqual(['created', 'deleted', 'modified']);
  });

  it('keeps ignored changes, marked rather than dropped', () => {
    // Dropping them would make this disagree with the counts elsewhere.
    const timeline = buildGroupTimeline([resource({ ignored: true, kind: 'added' })]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].ignored).toBe(true);
  });

  it('stamps every entry with when it was detected, not when it happened', () => {
    const timeline = buildGroupTimeline([resource({ kind: 'added' })], {
      detectedAt: '2026-08-31 09:15:00',
    });
    expect(timeline[0].detectedAt).toBe('2026-08-31 09:15:00');
    expect(timeline[0].occurredAt).toBeUndefined();
  });

  it('names the resource type rather than repeating the id', () => {
    expect(titleOf(resource({ kind: 'added' }))).toMatch(/^Provisioned /);
    expect(titleOf(resource({ kind: 'removed' }))).toMatch(/^Deleted /);
  });

  it('survives an empty group', () => {
    expect(buildGroupTimeline([])).toEqual([]);
    expect(buildGroupTimeline()).toEqual([]);
  });
});

group('attributing a change to a person', () => {
  const timeline = () => buildGroupTimeline([resource({ kind: 'added' })]);

  it('matches a resource id despite the two APIs disagreeing on casing', () => {
    // Resource Graph says resourceGroups, the Activity Log says resourcegroups.
    // Comparing literally matches nothing, and the failure is silent.
    const withActor = attachActors(timeline(), [{
      resource_id: timeline()[0].resourceId.replace('resourceGroups', 'resourcegroups'),
      caller: 'j.doe@example.com',
      timestamp: '2026-08-31T09:15:00Z',
      summary: 'Create or update virtual machine',
    }]);
    expect(withActor[0].actor).toBe('j.doe@example.com');
    expect(withActor[0].occurredAt).toBe('2026-08-31T09:15:00Z');
  });

  it('refuses to name anyone when several people touched the resource', () => {
    // A wrong name in an audit trail is worse than no name.
    const withActor = attachActors(timeline(), [
      { resource_id: timeline()[0].resourceId, caller: 'a@example.com', timestamp: '2026-08-30T09:00:00Z' },
      { resource_id: timeline()[0].resourceId, caller: 'b@example.com', timestamp: '2026-08-31T09:00:00Z' },
    ]);
    expect(withActor[0].actor).toBeNull();
    expect(withActor[0].actorCount).toBe(2);
  });

  it('reports the most recent operation when one person acted repeatedly', () => {
    const withActor = attachActors(timeline(), [
      { resource_id: timeline()[0].resourceId, caller: 'a@example.com', timestamp: '2026-08-29T09:00:00Z', summary: 'Older' },
      { resource_id: timeline()[0].resourceId, caller: 'a@example.com', timestamp: '2026-08-31T09:00:00Z', summary: 'Newer' },
    ]);
    expect(withActor[0].actor).toBe('a@example.com');
    expect(withActor[0].operation).toBe('Newer');
  });

  it('leaves an entry untouched when the log has nothing for it', () => {
    const withActor = attachActors(timeline(), [
      { resource_id: '/subscriptions/other/resourceGroups/rg-x/providers/p/t/n', caller: 'x@example.com' },
    ]);
    expect(withActor[0].actor).toBeUndefined();
  });

  it('ignores log entries carrying no resource id', () => {
    const withActor = attachActors(timeline(), [{ caller: 'ghost@example.com', resource_id: '' }]);
    expect(withActor[0].actor).toBeUndefined();
  });

  it('does nothing when the log could not be read', () => {
    expect(attachActors(timeline(), [])[0].actor).toBeUndefined();
    expect(attachActors(timeline())[0].actor).toBeUndefined();
  });
});
