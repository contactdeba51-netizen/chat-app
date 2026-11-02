import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// apiFetch() in App.jsx adds the session token from sessionStorage. The old
// global wrapper read a stale localStorage token and could override it, so it
// was removed; no token is attached to requests from this file.

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
