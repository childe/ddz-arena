// Reactive guest identity (token stored in localStorage via api.saveGuest).
import { useSyncExternalStore } from 'react';
import { type Account, loadGuest, saveGuest } from './api.ts';

let current: Account | null = loadGuest();
const listeners = new Set<() => void>();

export function getGuest(): Account | null {
  return current;
}

export function setGuest(g: Account | null): void {
  current = g;
  saveGuest(g);
  listeners.forEach((l) => l());
}

export function useGuest(): Account | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
  );
}
