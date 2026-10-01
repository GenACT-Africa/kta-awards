# KTA Awards: local voting system

The landing page, public ballot, jury scoring, organizer panel and results page for the Kenya–Tanzania Achievers Awards. It runs on your own computer with no extra packages.

## Run it

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

Stop the server with **Ctrl + C**. Everything is saved in `data/db.json`.

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

## Putting it online

As set up, the system works on your computer and on your Wi-Fi network (the Terminal prints a network address you can share at the venue). To let the public vote from anywhere, host it on a server with HTTPS, for example a small VPS or a Node host such as Render or Railway. Run `npm start` there, set `ADMIN_PASSWORD`, and back up `data/db.json`.

## Vote integrity: what it does and doesn't do

- One ballot per mobile number. Numbers are normalised, so `0712 345 678` and `+255 712 345 678` count as the same person.
- Phone numbers are never stored. Only a salted hash is kept.
- Sign-ins and logins are rate-limited per network, and organizer and jury actions need their own sessions.
- **The phone number isn't verified.** Someone could vote with numbers that aren't theirs. Before a public launch, connect a one-time-code check (for example Abila's WhatsApp Business API) at `POST /api/voter` in `server.js`, or count SMS/WhatsApp votes externally and enter the totals as off-platform votes.

## Files

```
server.js          Web server, API and scoring (no dependencies)
public/            Pages, styles and browser scripts
data/db.json       All data, created on first run (back this up)
data/admin-password.txt   Generated organizer password
```
