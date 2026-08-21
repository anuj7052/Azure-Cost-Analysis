import { NavLink } from 'react-router-dom';
import { LayoutDashboard, TrendingUp, Settings, AlertTriangle, Server, FolderOpen, Network, ClipboardList, FileCode, GitCompareArrows, ShieldCheck, Trash2, Search, Activity } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/search', label: 'Global Search', icon: Search },
  { to: '/trends', label: 'Cost Trends', icon: TrendingUp },
  { to: '/compare', label: 'Month Compare', icon: GitCompareArrows },
  { to: '/services', label: 'Services', icon: Server },
  { to: '/bandwidth', label: 'Bandwidth', icon: Network },
  { to: '/boq', label: 'BOQ vs Actual', icon: ClipboardList },
  { to: '/deploy', label: 'BOQ to Code', icon: FileCode },
  { to: '/anomalies', label: 'Anomalies', icon: AlertTriangle },
  { to: '/changes', label: 'Change Tracking', icon: GitCompareArrows },
  { to: '/activity', label: 'Activity Explorer', icon: Activity },
  { to: '/orphaned', label: 'Orphaned Resources', icon: Trash2 },
  { to: '/resource-groups', label: 'Resource Groups', icon: FolderOpen },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  const isAdmin = useAppStore(s => s.me?.is_admin);
  const nav = isAdmin
    ? [...NAV, { to: '/admin', label: 'Admin Center', icon: ShieldCheck }]
    : NAV;

  return (
    <aside className="w-60 min-h-screen bg-slate-900/90 border-r border-slate-800 flex flex-col sticky top-0 h-screen backdrop-blur-xl">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-slate-800">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0 shadow-lg shadow-blue-950/40">
          <svg viewBox="0 0 96 96" className="w-5 h-5 fill-[#fff]">
            <path d="M33.4 6.4L10 73.8h19.3l13.6-36.1 14.1 25.2-10.2 10.9H66l17.8 17.7H96L57.3 6.4H33.4z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-bold text-white leading-tight tracking-tight">Azure Cost</p>
          <p className="text-[11px] text-blue-400 font-medium tracking-wide uppercase">Intelligence</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-5 space-y-1.5">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                   ? 'bg-gradient-to-r from-blue-600/25 to-transparent text-blue-300 border border-blue-500/30 shadow-sm shadow-blue-950/20'
                   : 'text-slate-400 hover:text-white hover:bg-slate-800/80'
              }`
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-800">
        <p className="text-xs text-slate-600">Azure Cost Analysis v1.0</p>
      </div>
    </aside>
  );
}
