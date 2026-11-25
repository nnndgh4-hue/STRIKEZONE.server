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

## Leaderboards and titles
- GET /api/leaderboard: global top 100 (total points) and today's top 10 (points earned today, resets at midnight Adelaide time; set LB_TZ to change). Send the login token to also get your own rank. Players appear after their first cloud save. Each entry now carries `t` (the player's title) so name tags load together with the board.
- POST /api/gift (admin only): `{user,amount}` 1..1,000,000 gives coins to any existing username (including the admin). The coins are queued and claimed by that player's game (GET /api/gift, POST /api/gift/claim, token required), which bumps their saved coins.
- Weapon ids up to 63 are accepted in fx/state messages (new melee weapons).
- Admin moderation (admin only): GET /api/admin/users?q= searches players; POST /api/admin/ban `{user,banned}` bans or unbans (kept in kv `bans`). A banned account keeps its save and is hidden from the leaderboard; login, save and live play answer 403 `banned:true` and the game shows a YOU HAVE BEEN BANNED screen. POST /api/admin/reset `{user}` wipes that account's save and leaderboard row and stamps it (`rst`) so every device of that account wipes its local copy too.
- Solo watching: a logged-in player in an offline mode opens a WebSocket and sends `{t:'solo',token,map,mode,ch}`, then only `s` (position) and `fx` messages. The server keeps a hidden one-player room for them (listed in /api/online as kind `solo`) that others can spectate from the ONLINE list. Nothing else is accepted from a solo reporter.
- Global chat: `GET /api/gchat?since=<id>` returns new messages (anyone can read), `POST /api/gchat {m}` writes one (log in needed, 1.5 s between messages, swear filter, banned players blocked). The last 100 messages are kept in memory only, so a restart clears them.
- `/api/online?id=..&bye=1` removes that browser from the online count right away (sent when the page closes).
- On boot the accounts `nate` and `nihdih` are reset once (kv `autoreset1:<name>`), if they exist.
- Admin only: POST /api/title {user, text, color} sets a title (up to 16 characters, colour like #ffd400); empty text removes it. GET /api/titles lists them. New tables (lb, titles) are created automatically.


## Update 25 notes
- PvP rooms now vote between three PvP maps (`pv1`, `pv2`, `pv3`); normal rooms keep `ind`, `des`, `cit`.
- In PvP the `hit` damage limit is 500 (instant kills from a sniper headshot or a knife backstab); everywhere else it stays 250.
- New relay messages: `dr` (a dropped coin or gun appears for everyone) and `dp` (it was picked up). Rate limited.
- The bot snapshot rows now carry a ninth value, the bot's height, so players see bots on towers and upper floors.
- Upload `server.js` and `README.md` to GitHub, then press Manual Deploy on Render.

## Update 4 notes
- The six maps are `arena`, `dock`, `metro`, `neon`, `frost` and `outpost`. Normal rooms and PvP rooms vote between the same six; PvP rooms load the small version in the game and everything else loads the large one.
- Old map names (`ind`, `des`, `cit`, `pv1`, `pv2`, `pv3`) are no longer accepted for votes or room settings.
- Upload `server.js` and `README.md` to GitHub, then press Manual Deploy on Render.
- There is no maximum level (the server accepts levels up to 100000). Prestige still tops out at 10, reached at level 1000.


### PvP loadout break
The break between PvP rounds is now 10 seconds by default (env `PVP_BREAK`, milliseconds) so players can change weapons on the loadout screen.

## Update 5 notes
- Saves may now hold many more weapons and skins (up to 2000 entries per group and 150 KB per save).
- Prestige (level / 100, max 10) is read from the player's saved level and sent to other players in the room so it can show next to name tags.
- Hits in general servers may be up to 1000 damage (new sniper rifles). PvP is still capped at 500.

## Event timer (V81)

The admin (`AlphaNG7`, or whoever is in `ADMIN_USERS`) can start a named countdown from the home screen (EVENT TIMER (ADMIN)) or the command center (EVENT button). The server stores it in a new `kv` table (created automatically; with no database it is kept in the data file) so it survives restarts.

- `GET /api/live` returns `{now, ev}` where `ev` is `{n, end, set}` or `null`. Every open game polls it about every 20 seconds and corrects for clock differences using `now`.
- `POST /api/live` (admin only) with `{action:'start', name, ms}` starts the timer (name up to 60 characters, `ms` between 0 and 366 days) or `{action:'stop'}` removes it. After the timer ends the bubble says EVENT HAPPENING NOW until the admin stops it.

After updating `server.js`, redeploy on Render (Manual Deploy > Deploy latest commit).

## Online hub (V82)

- **Chat filter:** swear words in chat are replaced with `#` characters on the server, so it works for every player, including older game versions.
- **Currently online:** the game calls `GET /api/online?id=<random tab id>` about every 20 seconds (every 5 seconds while the ONLINE tab is open). Everyone who called it in the last 50 seconds counts as online, even on the home page. Nothing about the person is stored. The reply also lists the live public servers and PvP matches with their players, plus the PvP waiting groups (`pq`).
- **Watching:** a logged-in player can join a live public server or running PvP match as a spectator (`join` with `spec: roomId`). Spectators receive positions and bots but cannot move, shoot, chat, vote or take a slot, and private-code servers and PvP rooms still waiting for players cannot be watched. If the match empties, spectators are sent back to the menu.

After updating `server.js`, redeploy on Render (Manual Deploy > Deploy latest commit).
- Backstab check (PvP): a `hit` message with `bs:<activation id>` is checked against the last positions the server saw for both players (attacker within 4.6 m, in the back half of the victim and looking at them). If it fails, or two backstabs come less than 0.45 s apart, it counts as a plain 50 damage knife hit. The same activation id twice is dropped. Walls are checked by the game on the attacker's side, the server has no map.
- Stuck vote fix: a client that is still on the vote screen 2.5 s after the timer ended sends `{t:'sync'}` (at most once per 2 s). If the round is overdue the server starts it, and if the round is already running the client gets the current `go`. Every room is also wrapped in try/catch in the 500 ms loop so one bad room cannot stall the others.
- Ghost players: anyone who sends nothing (not even the 10 second ping) for 90 s is dropped (`GHOST_MS` changes it), so rooms do not fill up with dead connections.
- Shotgun fix: `hit` messages are still limited to one per 12 ms, but up to 10 arriving in the same 12 ms window (one shotgun volley) are all applied. Before, only the first pellet of a volley counted.

## V106: roles, test server, room commands

- **Roles** come live from the name tag beside a player's name (`/api/title`): a tag containing the word *developer* makes a developer, *tester* a tester (capital letters do not matter; developer wins if both). The admin account (`ADMIN_USERS`) stays admin. Roles are returned by `/api/login`, `/api/register` and `/api/me`, and pushed to a connected player as `{t:'role'}` the moment a tag is added or removed, so nobody needs to re-login.
- **Test server**: `join` with `test:1` is refused unless the account has a role. One room `test-room`, always in play, no round end, hidden from `/api/online` rooms and `/api/rooms`, not watchable; `/api/online` only reports `test: <players>`. `PUT /api/save` from a player inside it is accepted but ignored, so nothing earned there reaches the save or the leaderboard.
- **Commands** (`{t:'ac', c, a, to}`) are checked on the server against the sender's role every time. Testers and developers: `god, killred, heal, ammo, freeze` on any server. Test server extras: tester `superspeed, supergravity, infammo`; developer `taco, minigun, infammo, supergravity, superspeed, enlarge, dropgun, boss`. Everything else, and every `to` target list, is admin only. `adm` (freeze / kill red) is open to testers and developers, the other orders stay admin only.
- Commands only travel inside the room. God mode and one-shot kills are enforced here on `hit`; per-round effects are cleared when a round starts or ends and sent to late joiners (`acs`).

## V107: event timer effects

`POST /api/live` (admin) now accepts an optional `fx` (`'next'` = the thin animated next-update strip). Anything else is stored as an empty string. `GET /api/live` returns it with the event, so every home screen can draw the effect.
