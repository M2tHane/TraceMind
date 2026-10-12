import { createContext, useCallback, useContext, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError, post } from './api'
import type { Account } from './types'

interface AuthState { user: Account | null; loading: boolean; error: Error | null; signIn: (username: string, password: string) => Promise<Account>; signOut: () => Promise<void>; refresh: () => Promise<void> }
const AuthContext = createContext<AuthState | null>(null)
const ME = ['/auth/me']
type Client = ReturnType<typeof useQueryClient>

/** Switch the cached account and drop every other cached response (they belong to the previous account). */
function switchAccount(client: Client, account: Account | null): void {
  client.removeQueries({ predicate: query => query.queryKey[0] !== ME[0] })
  client.setQueryData(ME, account)
}

async function fetchMe(): Promise<Account | null> {
  try { return await api<Account>('/auth/me') } catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const me = useQuery<Account | null, Error>({ queryKey: ME, queryFn: fetchMe, staleTime: 60000, retry: false })
  const refresh = useCallback(async () => { await client.invalidateQueries({ queryKey: ME }) }, [client])
  useEffect(() => {
    // Any 401 means the session is gone: forget cached data from the previous account.
    const expired = () => { if (client.getQueryData(ME)) switchAccount(client, null) }
    window.addEventListener('auth:unauthorized', expired)
    return () => window.removeEventListener('auth:unauthorized', expired)
  }, [client])
  const signIn = useCallback(async (username: string, password: string) => {
    const account = await post<Account>('/auth/login', { username, password })
    switchAccount(client, account)
    return account
  }, [client])
  const signOut = useCallback(async () => {
    try { await post('/auth/logout') } finally { switchAccount(client, null) }
  }, [client])
  return <AuthContext.Provider value={{ user: me.data ?? null, loading: me.isPending, error: me.error, signIn, signOut, refresh }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}

export const useIsAdmin = (): boolean => useAuth().user?.role === 'admin'
