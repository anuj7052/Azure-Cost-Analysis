import { create } from 'zustand';

/**
 * Whether the navigation drawer is open on a small screen.
 *
 * This lives outside the sidebar because the button that opens it is in the
 * topbar, and outside `useAppStore` because it is pure interface state -- it
 * has nothing to do with tenants, subscriptions or cost data, and putting it
 * there would make every consumer of that store re-render when somebody taps
 * a hamburger.
 *
 * On desktop the drawer state is simply ignored: the rail is always visible
 * from `lg` upwards, so there is nothing to open or close.
 */
export const useNav = create((set) => ({
  navOpen: false,
  openNav: () => set({ navOpen: true }),
  closeNav: () => set({ navOpen: false }),
  toggleNav: () => set((s) => ({ navOpen: !s.navOpen })),
}));
