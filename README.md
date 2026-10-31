# iBroadcast 2.0

A mobile-friendly personal media library for local audio/video files and authorized direct media URLs.

## Deploy on Render
- Build command: `npm install`
- Start command: `npm start`
- Runtime: Node 20 or newer
- Keep `index.html`, `server.js`, and `package.json` in the repository root.

## Features
- Local audio/video file library stored in the browser IndexedDB
- Browser playback controls and playback queue
- Favorites, playlists, search, sort, and recently played history
- Analyze and download supported public direct media URLs (up to 250 MB)

## Important limitations
- This is browser-local storage: library files do not sync between devices or browsers.
- Clearing browser site data can erase the local library.
- Large local files use device/browser storage and available quota.
- Download behavior depends on Android browser and source server.
- YouTube/YouTube Music protected streams and DRM-protected media are not extracted.
- Render free instances may sleep when idle; first request can be slow.
- This is a first functional build, not a universal media downloader.
