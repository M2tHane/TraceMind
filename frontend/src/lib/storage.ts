import { useEffect, useState } from 'react'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch { return fallback }
}

/** useState mirrored to localStorage; storage failures (private mode, quota) fall back to memory only. */
export function useStoredState<T>(key: string, fallback: T): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback))
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* not persisted */ }
  }, [key, value])
  return [value, setValue]
}
