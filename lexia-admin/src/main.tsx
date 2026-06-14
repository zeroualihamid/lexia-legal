import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter as Router } from 'react-router-dom'
import './index.css'
import App from './App'
import { installCredentialedFetch } from './lib/credentialed-fetch'

// Send the better-auth session cookie on all backend requests (single-port auth).
installCredentialedFetch()

// Vite injects BASE_URL from `base` in vite.config.js (or VITE_BASE env).
// Dev: "/"  |  Prod under nginx /qclick/: "/qclick/"
// react-router expects no trailing slash, so strip it (except when it's just "/").
const rawBase = import.meta.env.BASE_URL || '/'
const basename = rawBase.length > 1 ? rawBase.replace(/\/+$/, '') : rawBase

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Router basename={basename}>
      <App />
    </Router>
  </StrictMode>,
)
