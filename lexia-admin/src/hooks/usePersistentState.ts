import { useCallback, useEffect, useRef, useState } from 'react';

const PREFIX = 'qadmin:hist:';

function load<T>(storageKey: string | null, initial: T): T {
  if (!storageKey) return initial;
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as T) : initial;
  } catch {
    return initial;
  }
}

function save<T>(storageKey: string, value: T) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    /* quota / serialization — ignore */
  }
}

/**
 * State mirrored to localStorage under `qadmin:hist:<key>`, so a panel's
 * conversation history survives navigation and reloads until explicitly
 * deleted. Passing `key === null` disables persistence (in-memory only).
 *
 * - Reloads when `key` changes (e.g. switching skill / conversation), writing
 *   to the key the current value belongs to (no cross-key bleed).
 * - Writes are debounced (coalesces streaming token updates) and flushed on
 *   unmount. `clear()` removes the stored entry and resets to `initial`.
 */
export function usePersistentState<T>(key: string | null, initial: T) {
  const storageKey = key ? PREFIX + key : null;
  const [state, setState] = useState<T>(() => load(storageKey, initial));

  // Track the key the current state belongs to, and the latest value (for flush).
  const keyRef = useRef(storageKey);
  const stateRef = useRef(state);
  stateRef.current = state;
  const initialRef = useRef(initial);
  initialRef.current = initial;

  // On key change: flush the previous key's current value (so a quick switch
  // can't drop a pending update), then load the new key's stored value.
  useEffect(() => {
    if (keyRef.current && keyRef.current !== storageKey) {
      save(keyRef.current, stateRef.current);
    }
    keyRef.current = storageKey;
    setState(load(storageKey, initialRef.current));
  }, [storageKey]);

  // Debounced persist (depends only on `state` so a key switch doesn't write
  // the old value to the new key — the key-change effect runs first).
  useEffect(() => {
    const k = keyRef.current;
    if (!k) return;
    const t = setTimeout(() => save(k, stateRef.current), 300);
    return () => clearTimeout(t);
  }, [state]);

  // Flush on unmount so a quick navigation doesn't drop the last update.
  useEffect(
    () => () => {
      if (keyRef.current) save(keyRef.current, stateRef.current);
    },
    [],
  );

  const clear = useCallback(() => {
    if (keyRef.current) {
      try {
        localStorage.removeItem(keyRef.current);
      } catch {
        /* ignore */
      }
    }
    setState(initialRef.current);
  }, []);

  return [state, setState, clear] as const;
}
