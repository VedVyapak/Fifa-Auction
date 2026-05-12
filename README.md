# FIFA Auction

Live, broadcast-style auction app for drafting football squads with friends. One laptop runs the host view; everyone bids from their phones over the internet.

- 7 bidders × 100M budget · 15-player squads · top 150 players
- 10s dynamic bid timer (resets on each bid)
- Reserve-budget rule keeps every squad fillable
- Soft position warnings (GK/DEF/MID/FWD) once you own 10+ players
- Host controls: pause, skip, undo last sale

## Stack

- Static HTML/CSS/JS — deploys to GitHub Pages
- Firebase Realtime Database for real-time sync between phones and laptop
- Optional Playwright scraper for fresh ratings from EA

## One-time setup

### 1. Firebase

1. Go to <https://console.firebase.google.com/> → **Add project** (free tier is fine).
2. In the project, click the **Web** (`</>`) icon → register an app. Copy the config object.
3. Open `firebase-config.js` and replace the placeholders with your config.
4. In the Firebase console: **Build → Realtime Database → Create database** (any region, "test mode" is fine for one auction night).
5. Confirm the `databaseURL` field in `firebase-config.js` matches what the Realtime Database page shows.

### 2. (Optional) Re-scrape player ratings

A curated `data/players.json` with 150 players is included so you can play immediately. To pull fresh ratings from EA's site:

```bash
cd scraper
npm install
npm run scrape
```

This overwrites `../data/players.json` with the top 150 by overall.

### 3. Deploy to GitHub Pages

```bash
git add .
git commit -m "Initial FIFA auction app"
# create a repo on github, then:
git remote add origin https://github.com/YOUR_USER/fifa-auction.git
git push -u origin main
```

In the repo → **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`. Wait a minute, then your auction lives at `https://YOUR_USER.github.io/fifa-auction/`.

## Auction night

1. Open the GitHub Pages URL on the **laptop**, click **Create new room** → a 4-letter code appears with a QR.
2. Each friend scans the QR (or visits the URL on their phone and taps **Join Auction**).
3. Once everyone's in, click **Start auction**.
4. Click **Auction next player** to draw a random unsold player.
5. Phones see the player + current bid; tap a quick-bid button or enter a custom amount.
6. When the 10s timer runs out with no new bid, the highest bid wins. Repeat.
7. Click **Finish auction** to see final squads with export-to-image.

### Host shortcuts

- **Pause / Resume** — freezes the current timer
- **Skip** — current player goes unsold, move on
- **Undo last sale** — refunds the last winner, returns the player to the pool

## Local dev

GitHub Pages works without a build step, but ES modules need a real HTTP server (not `file://`). Easiest:

```bash
python3 -m http.server 8000
# open http://localhost:8000 on the laptop
# phones on the same network: http://YOUR_LAPTOP_IP:8000/join.html
```

## File map

| File | Role |
| --- | --- |
| `index.html` + `js/host.js` | Laptop view: lobby, live auction, controls, leaderboard, finished |
| `join.html` | Mobile join screen (code + name) |
| `mobile.html` + `js/bidder.js` | Phone bidder view with hamburger squad drawer |
| `js/auction.js` | Pure rules: starting bid, reserve math, validation, position warnings |
| `js/firebase.js` | Firebase wiring: room CRUD, bid transactions, listeners |
| `firebase-config.js` | Your Firebase project keys — **edit this** |
| `data/players.json` | 150 players. Schema: `{ id, name, overall, position, club, nation, photo }` |
| `scraper/scrape.js` | Optional Playwright scraper for fresh EA ratings |
| `css/styles.css` | Broadcast/stadium-night design system |
