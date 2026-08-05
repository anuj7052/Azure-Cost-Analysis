import { create } from 'zustand';

const STORAGE_KEY = 'aca:theme';

function systemTheme() {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function initialTheme() {
  if (typeof window === 'undefined') return 'dark';
  return localStorage.getItem(STORAGE_KEY) || systemTheme();
}

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export const useTheme = create((set, get) => ({
  theme: initialTheme(),

  setTheme: (theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    apply(theme);
    set({ theme });
  },

  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));

/** Applies the persisted theme before React paints. Called from main.jsx. */
export function initTheme() {
  apply(useTheme.getState().theme);

  // Follow the OS only while the user has not made an explicit choice.
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', (e) => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    const next = e.matches ? 'light' : 'dark';
    apply(next);
    useTheme.setState({ theme: next });
  });
}

/**
 * Recharts renders into SVG and cannot read Tailwind classes, so charts pull
 * their palette from here to stay in step with the active theme.
 */
export function useChartTheme() {
  const theme = useTheme((s) => s.theme);
  const light = theme === 'light';

  return {
    theme,
    isLight: light,
    grid: light ? '#e2e8f0' : '#1e293b',
    axis: light ? '#64748b' : '#94a3b8',
    reference: light ? '#94a3b8' : '#475569',
    label: light ? '#475569' : '#94a3b8',
    tooltip: {
      background: light ? '#ffffff' : '#0f172a',
      border: `1px solid ${light ? '#e2e8f0' : '#1e293b'}`,
      borderRadius: 12,
      boxShadow: light
        ? '0 12px 28px -14px rgb(15 23 42 / 0.28)'
        : '0 12px 32px -12px rgb(0 0 0 / 0.65)',
      color: light ? '#0f172a' : '#e2e8f0',
      fontSize: 12,
      padding: '10px 12px',
    },
    tooltipLabel: {
      color: light ? '#0f172a' : '#e2e8f0',
      fontWeight: 600,
      marginBottom: 4,
    },
    tooltipCursor: { fill: light ? 'rgb(15 23 42 / 0.04)' : 'rgb(148 163 184 / 0.08)' },
    /** Categorical series palette — accessible in both themes. */
    series: light
      ? ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#ea580c', '#65a30d', '#0d9488']
      : ['#60a5fa', '#a78bfa', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#fb923c', '#a3e635', '#2dd4bf'],
  };
}
