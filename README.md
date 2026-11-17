# STRIKEZONE account server

This small server lets players create accounts and keep their game progress on every device.
The game page (index.html) stays on GitHub Pages. This server runs separately on Render.

## What you need (all free)
- A GitHub account (you already have one)
- A Render account: https://render.com
- A free Postgres database. Neon (https://neon.tech) is easy. Render's own free Postgres also works, but it expires after 30 days.

Why a database? Render's free web service forgets any files whenever it restarts, so accounts must live in Postgres.

## Step 1: Create the database (Neon)
1. Sign up at neon.tech and create a project (any name, any region near you).
2. On the project page, copy the **connection string** (it starts with `postgresql://`). Keep it private. It is the database password.

## Step 2: Put the server on GitHub
1. Make a new GitHub repository called `strikezone-server`.
2. Upload the two files from this folder: `server.js` and `package.json`. (Do not upload your connection string anywhere.)

## Step 3: Deploy on Render
1. In Render choose **New + > Web Service** and pick your `strikezone-server` repository.
2. Settings: Runtime **Node**, Build command `npm install`, Start command `npm start`, Instance type **Free**.
3. Under **Environment**, add one variable: `DATABASE_URL` = the connection string from Step 1.
4. Click **Create Web Service**. When it says "Live", open the address Render gives you (like `https://strikezone-server.onrender.com`). You should see `{"ok":true,"game":"strikezone","storage":"postgres"}`. If it says `"storage":"file"` the DATABASE_URL was not set.

## Step 4: Connect the game
1. Open the game and press **LOG IN / CREATE ACCOUNT**.
2. Paste your Render address into **Server address**, enter a username and password, and press **CREATE ACCOUNT**.
3. On another device, open the game, enter the same server address, and press **LOG IN**.

The game remembers the server address on each device. To skip typing it, open index.html in a text editor, find `var DEFAULT_API='';` and put your address between the quotes.

## Good to know
- Render's free service goes to sleep when nobody uses it. The first login after a quiet period can take up to a minute. The game tells you it is waking the server.
- Passwords are stored as salted scrypt hashes, never as plain text. Sessions last 90 days.
- Usernames are 3 to 20 letters, numbers or underscores. Passwords need 8 or more characters. There is no password reset yet, so keep it safe.
- Anti-cheat: the server checks every save. It rejects impossible values, and it limits how fast coins and XP can grow since the last save (a generous allowance plus a rate per second). A save that grows too fast is rejected and the player's last valid progress is restored. A first upload is limited to about Prestige 1 of XP and 100,000 coins.
- This stops casual editing, not a determined cheater who earns slowly, and it does not check which items were bought. Fully stopping cheating needs the server to run the matches, which would be part of real online multiplayer.

## Testing on your own computer (optional)
`node server.js` starts it on port 3000 using a local file instead of Postgres. Do not use that mode for a public server.

## Admin account (optional)
The server marks the username `alphang7` (any capitals) as the admin. To use different names, add an environment variable `ADMIN_USERS` in Render (comma separated, for example `name1,name2`) and redeploy. The admin password is never stored in the code. Create the admin account yourself as soon as the server is updated, so nobody else can take the name.


## Live events (admin broadcasts)
The server also keeps a short in-memory list of live events. The admin account (`AlphaNG7`, or whoever is in the `ADMINS` variable) can send them from the in-game command center (`POST /api/event`). Every open game polls `GET /api/events` every few seconds and plays any new event. Events are kept for 2 minutes and then forgotten, so nothing is stored in the database. After updating `server.js`, redeploy on Render (Manual Deploy > Deploy latest commit).

## Live play (WebSocket)
`server.js` now also runs the live game rooms (no extra packages needed). Players connect to `/ws` with their login. Each room holds up to 12 players, at most 10 per team; when a room is full another one opens. One player's game runs the bots for the room, and the server passes positions between everyone. Rooms live in memory only.
To update: upload the new `server.js` to GitHub, then on Render use Manual Deploy > Deploy latest commit. Check `/api/health`, it now shows `rooms` and `online`.

The server now also passes hits between players, counts team kills per room, and ends a round at 50 kills.


## Server list, private servers, chat
`GET /api/rooms` lists public servers. A join message may include `room` (id), `code` (private code) or `create:1` (new private server). Chat is `{t:'c',m}` and stays inside one server. Admin accounts may be connected from two windows.

## Map voting and rounds
A room starts in a 10 second vote phase (`VOTE_MS`), then plays a round (50 kills or 10 minutes), shows results for 6 seconds (`RES_MS`), then votes again. Messages: `vote`, `vt`, `go`, `end` (with `rs` and `vl`). Thrown grenades use `nd` and `nx`.

## Private servers with your own code
"CREATE PRIVATE SERVER" lets the creator type a code (3-10 letters/numbers). Codes are unique; others join with JOIN WITH CODE and the exact code. Private servers never show in the list.

## PvP queues
Players join a PvP queue (1v1, 2v2 or 3v3) from the ONLINE panel. When the queue is full the room goes to a map vote, then plays best of up to 9 rounds: no bots, one life per round, first team to 3 round wins. Round time 120 s (env PVP_RT), break between rounds 4 s (env PVP_BREAK). PvP rooms never appear in the server list.

## Co-op waves
"ONLINE CO-OP" (from PLAY when the mode is Wave Survival) joins a co-op room: up to 6 players, all on one team, host's game runs the enemies, one life each. If every player is down the room restarts from wave 1 after 5 s. Co-op rooms are not in the server list; private co-op rooms use a code like any private server.
