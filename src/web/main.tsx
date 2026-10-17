import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '../renderer/App'
import '../renderer/calibration.css'
import '../renderer/styles.css'
import { installWebApi } from './api'

// The bridge must exist before the app's effects run: the renderer is untouched
// and still talks to `window.sticklab`, exactly as it does under Electron.
installWebApi()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
