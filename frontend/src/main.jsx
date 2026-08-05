import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initTheme } from './store/useTheme'

// Apply the persisted / system colour theme before the first paint.
initTheme()

// Do NOT call msalInstance.initialize() manually — MsalProvider v5 handles it.
// Do NOT use React StrictMode — double-invokes effects, breaks MSAL redirect.
createRoot(document.getElementById('root')).render(<App />)
