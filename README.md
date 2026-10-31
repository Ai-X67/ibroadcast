# iBroadcast 2.0.1

A mobile-friendly personal media library for local audio/video files and authorized direct media URLs. Features a built-in player, persistent browser storage via IndexedDB, and server-side URL validation.

## Deploy on Render
- **Build command:** `npm install` (or leave empty as there are no external dependencies)
- **Start command:** `npm start`
- **Runtime:** Node 20 or newer
- Keep `index.html`, `server.js`, and `package.json` in the repository root.

## Features
- **Local Storage:** Audio/video file library stored safely in the browser's IndexedDB.
- **Media Player:** Fully integrated bottom player with queue management and seek controls (fixed anti-jitter logic).
- **Collections:** Favorites, playlists, search, sort, and history functions.
- **Link Analyzer & Downloader:** Securely analyze and download supported public direct media URLs (up to 250 MB) without exposing server IPs.

## Important Limitations
- **Local Persistence:** This relies on browser storage. Data does not sync between devices. Clearing browser site data will erase your library.
- **Large Files:** Storing large local files consumes your device storage and is subject to the browser's storage quota constraints.
- **Copyrighted Streams:** YouTube/YouTube Music protected streams and DRM-encrypted media cannot be extracted or processed.
- **Render Cold Starts:** Free instances on Render spin down after inactivity; the initial request may take up to 50 seconds to respond.
- 
