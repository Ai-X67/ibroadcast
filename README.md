# iBroadcast 3.0 — Universal Media Hub & Download Manager

A full-stack personal media library, offline audio/video player, and multi-engine download manager supporting local files, direct media streams, and major social platforms.

## Supported Platforms & Formats
- **Social Platforms:** YouTube, YouTube Music, TikTok, Instagram, Facebook, X (Twitter), and SoundCloud.
- **Direct Links:** MP3, M4A, WAV, AAC, OGG, FLAC, MP4, and WebM (up to 400 MB).
- **Format Selection:** Choose between **Auto (Best)**, **Audio Only (MP3/M4A)**, or **Video (MP4)** before extracting.

## Core Architecture & Features
- **Multi-Engine Cloud Fallback:** Automatically routes extraction requests across multiple node pools (Cobalt API Pool, Piped API Pool, Invidious Nodes, TikWM, and local `@distube/ytdl-core`) to bypass HTTP 429 rate-limits on free cloud hosting.
- **Multi-Task Download Manager:** Supports up to 2 simultaneous downloads with real-time speed tracking, progress bars, pause/resume (via HTTP Byte-Range headers), retry, and cancel controls.
- **Offline Browser Library (IndexedDB):** Save downloaded streams or local device files directly into your browser's persistent IndexedDB storage for offline playback[span_0](start_span)[span_0](end_span)[span_1](start_span)[span_1](end_span).
- **Built-in Media Player:** Includes queue management, anti-jitter seek bar, volume control, Shuffle (`⇄`), and Repeat (`↻`) modes[span_2](start_span)[span_2](end_span).

## Deploy on Render
- **Repository:** `Ai-X67/ibroadcast`
- **Build Command:** `npm install`[span_3](start_span)[span_3](end_span)
- **Start Command:** `npm start`[span_4](start_span)[span_4](end_span)
- **Node Engine:** `>=20.0.0`[span_5](start_span)[span_5](end_span)[span_6](start_span)[span_6](end_span)
- Keep `index.html`, `server.js`, `package.json`, and `README.md` in the root directory[span_7](start_span)[span_7](end_span)[span_8](start_span)[span_8](end_span).

## Important Notes & Limitations
- **Browser Storage Quota:** Offline library files are stored locally in your browser's IndexedDB and do not sync across devices[span_9](start_span)[span_9](end_span)[span_10](start_span)[span_10](end_span). Clearing browser site data will delete saved offline media[span_11](start_span)[span_11](end_span).
- **Public Content Only:** Private, age-restricted, or login-walled social media posts cannot be extracted without authentication.
- **Render Free Tier:** Free instances spin down after inactivity; the initial request after idle time may take 30–50 seconds to wake the server[span_12](start_span)[span_12](end_span).
