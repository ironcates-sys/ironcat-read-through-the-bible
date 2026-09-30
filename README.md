# Read Through the Bible

A **private** audio Bible read-through PWA for Steve and his wife. It plays the prophets plan
(66 days × 6 chapters, then the plan repeats) by streaming audio from the
[Bible Brain](https://www.faithcomesbyhearing.com/bible-brain) API (Faith Comes By Hearing / DBP).

- Plain HTML/CSS/JS front end in `public/` (no framework, no build step beyond generating the plan JSON).
- Netlify Functions in `netlify/functions/` hold the Bible Brain key and a passcode gate.
- Installable on iPhone (Add to Home Screen), lock-screen controls via the Media Session API.

## How it works

| Piece | Notes |
|---|---|
| Plan | `data/prophets-daily-reading-plan.csv` → `public/data/plan.json` (`npm run plan`, also runs on Netlify build). Translation-independent: `{book, bookId, chapter}` items, six per day, 66 days. |
| Queue | Plays the six chapters in plan order and auto-advances. After chapter 6 the day is marked done and the next unread day is loaded. After day 66 a new cycle begins. |
| Progress | `localStorage` only (day, chapter position, seconds into chapter, cycle, done days per cycle, saved verses). Nothing is stored server-side. Progress lives in the browser/PWA on each device separately. |
| Streak | Gentle: "N of 66 days read this cycle", "x of the last 7 days". A missed day just pauses: nothing resets and there is no scolding. "Skip to today" jumps to the calendar day; "Jump to a day" picks any day. |
| Audio | **One** reused `<audio>` element. Each chapter's signed URL is requested from `/api/chapter` right before play; the next chapter's URL is requested ~25 s before the current one ends. |
| Announcements | Optional short clip ("Isaiah, chapter one") played through the same audio element before each chapter; single-chapter books (Obadiah) say only the name. Toggle in Settings. If a clip is missing the app silently skips it. |
| Translation | Picker is built from `/api/translations` at every launch (English audio filesets that include the Old Testament). Changing it applies from the next chapter. Default lives in Settings. |
| Legal | The playing translation's copyright text (from Bible Brain) and a link to the Bible Brain terms are always shown at the bottom. |

### API (all under `/api/*`, every function checks the token itself)

- `POST /api/auth` `{passcode}` → `{token, expiresAt}` (token = HMAC-signed, 30 days; changing `ACCESS_PASSCODE` invalidates all tokens)
- `GET /api/translations` → translation list
- `GET /api/chapter?fileset=&book=&chapter=&bible=` → `{audioUrl, duration, copyright, bookName, ...}` only
- `GET /api/timestamps?fileset=&book=&chapter=` → verse start times (used by "Save this verse")

All responses carry `Cache-Control: no-store`. The key is used only inside the functions and is scrubbed from any error text.
Without `BIBLE_BRAIN_KEY` the functions return clearly labelled **MOCK** data (a generated test tone, `mock: true`, and a banner in the UI).

## Setup

### 1. Get the repo onto Netlify
1. Netlify → *Add new site* → *Import from Git* → pick this repo (or the `scaffold` branch for a deploy preview).
2. Build settings are in `netlify.toml` (publish `public`, functions `netlify/functions`).
3. Site settings → *Environment variables*:

   | Name | Value |
   |---|---|
   | `BIBLE_BRAIN_KEY` | your personal Bible Brain API key (request one at <https://4.dbt.io/api_key/request>) |
   | `ACCESS_PASSCODE` | the passcode you and your wife will type in the app (make it long; it is the only gate) |
   | `BIBLE_LANGUAGES` *(optional)* | comma-separated ISO 639-3 codes, default `eng` |

   Mark `BIBLE_BRAIN_KEY` and `ACCESS_PASSCODE` as secret / "contains secret values" and scope them to Functions if Netlify offers it.
4. Deploy. Open the site on the iPhone in Safari → Share → *Add to Home Screen*.

### 2. Local development
```bash
cp .env.example .env            # then set ACCESS_PASSCODE (leave BIBLE_BRAIN_KEY blank for MOCK data)
node scripts/dev-server.js      # http://localhost:8888, serves public/ and runs the functions
npm test                        # plan + queue logic + function auth/no-leak tests (node:test, no dependencies)
```
`netlify dev` (Netlify CLI) also works and is closer to production.
`.env` is git-ignored. **Never commit a real key.**

### 3. Regenerating generated files
- Plan JSON: `npm run plan`
- Icons (placeholders): `npm run icons` (replace `public/icons/*` with real art whenever you like)
- Announcement clips: see `scripts/generate-announcements.py` (Piper TTS; clips for all 250 needed book/chapters are committed, ≈3 MB)
- After changing any shell file, bump `APP_VERSION` in `public/js/version.js`: installed copies then show a "new version is ready" banner and refresh when you choose.

## Service worker / caching rules
`public/sw.js` caches **only** the app shell, `plan.json`, and the announcement clips, in a versioned cache (`ironcat-shell-<version>`).
Requests to `/api/*` and to any other origin (Bible Brain's audio CDN) are **not intercepted at all**, so audio, text and function responses are never stored.
Offline, the app opens but cannot play Bible audio (by design).

## Testing checklist on the real iPhone
Install to Home Screen first (Safari → Share → Add to Home Screen), then open from the icon.

- [ ] Passcode screen appears on first launch; wrong passcode is refused; right one opens the app; "Lock this device" returns to the gate.
- [ ] Home shows six chapters for today and a big Play button; translation list loads (no MOCK banner once the key is set).
- [ ] Play starts (announcement first, if enabled), copyright line and terms link show for the playing translation.
- [ ] **Lock screen:** lock the phone; title/artist/artwork show; play/pause, next/previous chapter and 15 s back/forward work; scrubbing works.
- [ ] **Auto-advance with screen off:** start chapter 1, lock the phone, leave it through at least 3 chapter boundaries (try a short one like Haggai/Obadiah-length reading days). It must continue to the next chapter by itself. *(Risk point: iOS may suspend the page when the audio element is swapped; if it stalls at a boundary, note which boundary: announcement→chapter, chapter→announcement, or chapter→pause.)*
- [ ] Speed 0.75×–1.5× sticks across chapters; 15 s back works.
- [ ] Sleep timer: "End of chapter" and "15 min" stop playback and keep your place.
- [ ] Pause after each chapter (Settings) adds a gap and then continues.
- [ ] **Phone call:** play, receive/make a call; audio pauses, and after the call you can resume (tap Play or the lock-screen button). Position is kept.
- [ ] **Airplane mode:** with the app open and paused, airplane mode on → app shell still opens, tapping Play shows a friendly offline message (no crash). Turn airplane mode off → Play works again. Also mid-chapter: toggling airplane mode should stall playback, not corrupt progress.
- [ ] Close and reopen the app: day, chapter, and (roughly) the second are restored.
- [ ] Mark day read / not read, Jump to a day, Skip to today after a couple of days away.
- [ ] Save this verse → appears under ★ Saved (reference only, no text).
- [ ] Switch translation mid-chapter: current chapter keeps playing; the next chapter uses the new one.
- [ ] After a long pause (> 1 day) signed URLs expire, but the app resolves a fresh URL on resume/next play.

## License / terms notes (please read)
- **Private family use only.** Do not share the site URL, passcode, or key; do not publish this app or make it public.
- **Stream only.** Do not download, save, or re-host audio or text. The app never caches Bible Brain audio/text/API responses (service worker included). Do not add offline-audio features unless the fileset is marked downloadable by Bible Brain via its `/download` endpoints.
- **Show copyright and terms.** The UI shows the translation's copyright text and links to the Bible Brain terms: <https://www.faithcomesbyhearing.com/bible-brain/terms-conditions>. The API licence is at <https://www.faithcomesbyhearing.com/bible-brain/license>. Keep both visible.
- **Your API key is personal** ("you may not share your API Key with any other person"). It lives only in Netlify environment variables and is used server-side. Never paste it into the front end, git, chat or screenshots. If it leaks, ask Faith Comes By Hearing to rotate it.
- The API licence expects content to be provided to end users free of charge and in a manner that honours God; this app charges nothing and has no ads.
- Individual translations carry their own copyrights/permissions (shown in-app). Some filesets may be restricted for your key; the picker lists only what the API returns for it.
- Announcement clips are synthesized with [Piper](https://github.com/rhasspy/piper) and the `en_US-lessac-medium` voice (model card: trained on the Lessac Blizzard 2013 dataset; its licence page is at <https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html>). **TODO(Steve):** this is for private use only; if the site is ever shared, regenerate the clips with a clearly permissive voice.

## TODOs / open decisions
- Confirm the DBP terms link wording/URL (`https://www.faithcomesbyhearing.com/bible-brain/terms-conditions` is live; the `/legal/terms-of-use` URL suggested earlier returns 404).
- Real icons (current ones are placeholders).
- Choose default translation after the first real launch (Settings → Default translation).
- Decide whether to add Netlify's site-wide password / IP restrictions as a second layer (the in-app passcode is the only gate today).
- Bible Brain response shapes were written from the published OpenAPI file and **have not been tested against the live API with a real key**; check `/api/translations` and `/api/chapter` on first deploy (Netlify function logs show errors, never the key).

## Layout
```
netlify.toml
netlify/functions/   auth.js translations.js chapter.js timestamps.js lib/{common,mock}.js
public/              index.html sw.js manifest.webmanifest robots.txt css/ js/{app,queue,version}.js
                     data/plan.json announce/*.mp3 icons/ mock/tone.mp3
data/                prophets-daily-reading-plan.csv
scripts/             csv-to-plan.js dev-server.js make-icons.py generate-announcements.py e2e-smoke.js
tests/               queue.test.js functions.test.js
```
