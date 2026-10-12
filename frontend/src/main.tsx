import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import App from './App'
import { ApiError } from './lib/api'
import { AuthProvider } from './lib/auth'
import './styles.css'
import './styles/chat-workspace.css'
import './styles/tracemind.css'

const client = new QueryClient({ defaultOptions: { queries: { staleTime: 10000, retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 1, refetchOnWindowFocus: true }, mutations: { retry: false } } })
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><AuthProvider><BrowserRouter><App /></BrowserRouter></AuthProvider><Toaster position="top-right" richColors closeButton duration={5000} /></QueryClientProvider></React.StrictMode>)
