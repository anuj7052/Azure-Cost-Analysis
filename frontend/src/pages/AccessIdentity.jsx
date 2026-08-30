/**
 * Access & Identity — the two halves of "who can reach what", in one place.
 *
 * These were separate pages, and separating them made the reader do the join.
 * Access Optimization answers "which grants look wrong"; Role Assignments
 * answers "what can this person actually reach". Neither question is finished
 * on its own: a finding is only actionable once you have seen everything else
 * that account holds, and a person's access list only becomes interesting when
 * something about it is flagged.
 *
 * The two views are kept as distinct tabs rather than being fused into a single
 * feed, because they are genuinely different shapes of question — one starts
 * from a finding, the other from a principal — and merging them into one list
 * would have meant dropping columns from both. Every field, filter and control
 * that existed on the old pages still exists here, unchanged.
 *
 * The tab lives in the URL so that a link to a specific view still works, and
 * so the old `/access-optimization` and `/role-assignments` paths can redirect
 * here without losing where they were pointing.
 */
import { useSearchParams } from 'react-router-dom';
import { KeyRound, UserCog } from 'lucide-react';
import AccessOptimization from './AccessOptimization';
import RoleAssignments from './RoleAssignments';
import {
  VIEW_KEYS, VIEW_LABEL, VIEW_BLURB, viewFromParams,
} from '../utils/accessIdentity';

const VIEW_ICON = { optimization: KeyRound, assignments: UserCog };

export default function AccessIdentity() {
  const [params, setParams] = useSearchParams();
  const view = viewFromParams(params);

  function select(key) {
    const next = new URLSearchParams(params);
    next.set('view', key);
    // Replace rather than push: flipping between two tabs is not a step in a
    // journey, and stacking it in history would make Back mean "the other tab"
    // instead of "the page I came from".
    setParams(next, { replace: true });
  }

  return (
    <div>
      <div className="mx-auto max-w-screen-2xl px-6 pt-6">
        <div className="flex flex-wrap items-center gap-1 rounded-2xl border border-slate-800 bg-slate-900 p-1">
          {VIEW_KEYS.map((key) => {
            const Icon = VIEW_ICON[key];
            const active = key === view;
            return (
              <button
                key={key}
                onClick={() => select(key)}
                title={VIEW_BLURB[key]}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition ${
                  active
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                }`}
              >
                <Icon size={14} />
                {VIEW_LABEL[key]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Each view keeps its own header, refresh control and freshness stamp.
          They ask Azure different questions, so one shared "last updated" would
          claim a currency that only one of them had. */}
      {view === 'assignments' ? <RoleAssignments /> : <AccessOptimization />}
    </div>
  );
}
