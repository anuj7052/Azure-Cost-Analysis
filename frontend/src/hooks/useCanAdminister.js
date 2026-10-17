import { useAppStore } from '../store/useAppStore';

/** True when the signed-in user may change things in this workspace. */
export function useCanAdminister() {
  return useAppStore(state => state.me?.can_administer === true);
}
