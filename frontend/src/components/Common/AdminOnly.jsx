/** Shown in place of a write button for members who are not workspace admins. */
export function AdminOnlyNote({ className = '' }) {
  return <span className={`text-[11px] text-slate-500 ${className}`}>Workspace admins only</span>;
}
