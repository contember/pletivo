/**
 * Server-side hook stubs — match Preact's hook API but do nothing.
 * On the client, Bun plugin resolves `preact/hooks` to real Preact,
 * so these only run during SSR.
 */

type StateUpdater<T> = (value: T | ((prev: T) => T)) => void;

export function useState<T>(initial: T | (() => T)): [T, StateUpdater<T>] {
  const value = typeof initial === "function" ? (initial as () => T)() : initial;
  return [value, () => {}];
}

export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialState: S,
): [S, (action: A) => void] {
  return [initialState, () => {}];
}

export function useEffect(_fn: () => void | (() => void), _deps?: unknown[]): void {}

export function useLayoutEffect(_fn: () => void | (() => void), _deps?: unknown[]): void {}

export function useRef<T>(initial: T): { current: T } {
  return { current: initial };
}

export function useMemo<T>(fn: () => T, _deps?: unknown[]): T {
  return fn();
}

export function useCallback<T extends Function>(fn: T, _deps?: unknown[]): T {
  return fn;
}

export function useContext<T>(_context: any): T {
  return undefined as T;
}
