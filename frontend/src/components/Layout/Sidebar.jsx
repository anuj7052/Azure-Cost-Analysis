import { NavLink } from 'react-router-dom';
import { LayoutDashboard, TrendingUp, Settings, AlertTriangle, Server, FolderOpen, Network, ClipboardList, FileCode } from 'lucide-react';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/trends', label: 'Cost Trends', icon: TrendingUp },
  { to: '/services', label: 'Services', icon: Server },
  { to: '/bandwidth', label: 'Bandwidth', icon: Network },
  { to: '/boq', label: 'BOQ vs Actual', icon: ClipboardList },
  { to: '/deploy', label: 'BOQ to Code', icon: FileCode },
  { to: '/anomalies', label: 'Anomalies', icon: AlertTriangle },
  { to: '/resource-groups', label: 'Resource Groups', icon: FolderOpen },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  return (
    <aside className="w-60 min-h-screen bg-slate-900 border-r border-slate-800 flex flex-col sticky top-0 h-screen">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-slate-800">
        <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
          <svg viewBox="0 0 96 96" className="w-5 h-5 fill-[#fff]">
            <path d="M33.4 6.4L10 73.8h19.3l13.6-36.1 14.1 25.2-10.2 10.9H66l17.8 17.7H96L57.3 6.4H33.4z" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-white leading-tight">Azure Cost</p>
          <p className="text-xs text-slate-400">Analysis</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-600/20 text-blue-400 border border-blue-600/30'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800'
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
