import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import App from './App'
import { ApiError } from './lib/api'
import { AuthProvider } from './lib/auth'
import './styles/index.css'

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10000, retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1, refetchOnWindowFocus: true }, mutations: { retry: false } } })
// Notifications: bottom-right cards, 4 s, hover pauses, at most three at once (styled in ui.css).
const toastClasses = { toast: 'tm-toast', title: 'tm-toast-title', description: 'tm-toast-desc', icon: 'tm-toast-ic', closeButton: 'tm-toast-close', actionButton: 'tm-toast-action', success: 'tm-toast-success', error: 'tm-toast-danger', warning: 'tm-toast-warning', info: 'tm-toast-info' }
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><AuthProvider><BrowserRouter><App /></BrowserRouter></AuthProvider>
  <Toaster position="bottom-right" offset={76} gap={8} visibleToasts={3} duration={4000} closeButton containerAriaLabel="通知" toastOptions={{ unstyled: true, classNames: toastClasses }} />
</QueryClientProvider></React.StrictMode>)
