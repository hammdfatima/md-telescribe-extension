/**
 * Copy to config.js and set URLs for your environment.
 *
 * Local dev (API + web app on your machine):
 *   API_BASE_URL = http://localhost:5000
 *   APP_BASE_URL = http://localhost:3000
 *
 * Dev extension against production AWS:
 *   API_BASE_URL = https://api.mdtelescribe.com
 *   APP_BASE_URL = https://mdtelescribe.com
 *
 * Chrome Web Store build (production):
 *   Use the same production URLs. Package with `npm run package` before upload.
 */
const API_BASE_URL = "http://localhost:5000"
const APP_BASE_URL = "http://localhost:3000"

const AUTH_STORAGE_KEY = "authSession"
