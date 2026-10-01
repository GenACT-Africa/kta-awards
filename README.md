# KTA Awards voting system

The landing page, public ballot, jury scoring, organizer panel and results page for the Kenya–Tanzania Achievers Awards. It runs on Netlify (pages plus a Netlify Function, with data in Netlify Blobs) or on your own computer.

## Deploy on Netlify

The repo includes `netlify.toml`, so Netlify serves `public/` and runs the API from `netlify/functions/api.mjs`.

1. In Netlify, open the project → **Project configuration → Environment variables** and add:
   - `ADMIN_PASSWORD`: the organizer password.
   - `KTA_SECRET`: a long random string, at least 32 characters. It signs sign-in cookies and scrambles phone numbers. **Set it once and never change it**: changing it signs everyone out and makes earlier voters look new.
2. Trigger a redeploy (**Deploys → Trigger deploy**).
3. Open `https://<your-site>.netlify.app/admin` and sign in.

Votes, jury scores and settings live in the project's Netlify Blobs store named `kta-awards`. They are kept across deploys.

## Run it on your computer

1. Install **Node.js 18 or newer** from https://nodejs.org (check with `node -v`).
2. Open Terminal in this folder and run:

   ```
   npm start
   ```

3. Open http://localhost:3000. The organizer password is printed in the Terminal and saved in `data/admin-password.txt`.

To use your own password or port:

```
ADMIN_PASSWORD="choose-a-strong-one" PORT=8080 npm start
```

Stop the server with **Ctrl + C**. Local data is saved under `data/` and is separate from the Netlify data.

## Pages

| Address | Who uses it | What it does |
|---|---|---|
| `/` | Everyone | Landing page: categories, judging, gala, sponsorship, contacts |
| `/vote` | Public | Voters enter a mobile number, then pick one finalist per category |
| `/results` | Everyone | Shows official results once the organizer publishes and reveals them |
| `/jury` | Jurors | Sign in with an access code and score finalists on 5 criteria (1–10) |
| `/admin` | Organizers | Nominees, off-platform votes, jurors, categories, settings, live results, CSV export |

## How scoring works

- **Public score:** a nominee's share of the category's public votes (online votes plus any off-platform votes you enter), from 0 to 100.
- **Jury score:** each juror's total across the 5 criteria, scaled to 100 and averaged over the jurors who scored every criterion.
- **Final score:** jury weight × jury score + public weight × public score. The default is 80% jury and 20% public. Change it in **Settings & categories**.

Results stay hidden until you click **Publish results** and turn on **Show published results**. Publishing saves a snapshot, so to include later votes, publish again.

## First-time setup checklist

1. Sign in at `/admin` and delete the two **Sample** nominees in Educator of the Year.
2. Add the remaining categories (the deck names 17 of the 33).
3. Add finalists under **Nominees**.
4. Add jurors under **Jury panel** and send each one their access code privately. Each code is shown only once.
5. Confirm the jury/public split and add a closing note, such as the voting deadline.

## Other hosting

`npm start` also runs on any Node host (a VPS, Render, Railway). Set `ADMIN_PASSWORD` and `KTA_SECRET`, put it behind HTTPS, and back up the `data/` folder.

## Vote integrity: what it does and doesn't do

- One ballot per mobile number. Numbers are normalised, so `0712 345 678` and `+255 712 345 678` count as the same person.
- Phone numbers are never stored. Only a salted hash is kept.
- Sign-ins and logins are rate-limited per network, and organizer and jury actions need their own sessions.
- **The phone number isn't verified.** Someone could vote with numbers that aren't theirs. Before a public launch, connect a one-time-code check (for example Abila's WhatsApp Business API) at `POST /api/voter` in `lib/app.js`, or count SMS/WhatsApp votes externally and enter the totals as off-platform votes.

## Files

```
lib/app.js                  API and scoring, shared by both setups
netlify/functions/api.mjs   Netlify Function: runs the API, stores data in Netlify Blobs
netlify.toml                Netlify settings (publish folder, functions, security headers)
server.js                   Local server: runs the same API, stores data in data/
public/                     Pages, styles and browser scripts
data/                       Local data and generated secrets (not in git)
```
