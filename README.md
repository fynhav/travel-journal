# travel-journal

Phone-first travel journal. Installs from Safari (Add to Home Screen) and works fully offline.

- `index.html` is the whole app; `sw.js` keeps it, its fonts and JSZip (`vendor/`) on the phone.
- Bump `APP_VERSION` in `index.html` on every release. The service worker is registered as `sw.js?v=<version>`, so a new version gets a fresh cache.
