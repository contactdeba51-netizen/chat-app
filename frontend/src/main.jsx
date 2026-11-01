import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const originalFetch = window.fetch.bind(window)
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url
  const token = localStorage.getItem('chat-access-token')
  if (url.includes('/api/') && token) {
    return originalFetch(input, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
