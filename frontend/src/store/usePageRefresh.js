import { create } from 'zustand';

/** The mounted page owns which queries the header Refresh action should run. */
export const usePageRefresh = create(set => ({
  handler: null,
  register: handler => {
    set({ handler });
    return () => set(state => state.handler === handler ? { handler: null } : state);
  },
}));
