# Mvmnt Tribe app

The members' app: log in with your phone number and a password, then see your
kilometres, runs, rank, badge and recent runs.

Built with React + Vite, backed by the Mvmnt Tribe Supabase project
(`lligzqocyumszoecszyf`, Mumbai). Mobile-first, white with black type; badges are
the only colour.

## How login works

- **The phone number is the username.** First time in, a member creates a
  password; after that they log in with number + password.
- **Existing runners keep their history.** If the number is already on the run
  tracker, the new login is attached to that record, so they see their km,
  runs and badges straight away. New numbers are asked for a name.
- **Under the hood** each login is a normal Supabase Auth account with a private
  placeholder email (`<phone>@members.mvmnttribe.app`). Members never see it.
  This gives real password hashing, sessions and automatic token refresh without
  needing an SMS provider.
- **Sign-up** goes through the `member-auth` edge function, which refuses to create
  a second account on a number that already has one.
- **Privacy.** Every table is locked. A logged-in member can only read their own
  profile, through `my_profile()`. Logged-out visitors get nothing.

### Known limitation: nothing proves the number belongs to the person

There's no SMS code, so whoever creates the password first owns that number's
login. If someone claims the wrong number, or a member forgets their password,
reset it (below). Adding a WhatsApp/SMS code later doesn't need any rebuild.

## Resetting a member's login (forgotten password)

Run this in the Supabase SQL editor (or ask Claude):

```sql
select public.admin_reset_account('9876543210');
```

This removes only the login. Their member record, runs and badges stay. They then
open the app, enter their number, and create a new password.

## Settings — `src/config.js`

| Setting | What it is |
|---|---|
| `ADMIN_WHATSAPP` | Your WhatsApp number with country code (e.g. `919876543210`). When set, "Forgot password?" shows a button that opens WhatsApp with a pre-filled message. |
| `SUPABASE_URL`, `SUPABASE_KEY` | The project and its publishable key. Safe to be public. |
| `EMAIL_DOMAIN` | Must match the edge function. Don't change it. |

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build into dist/
```

## Deploy to Vercel

**Recommended — GitHub + Vercel (redeploys automatically on every change):**
1. Create a new GitHub repository and upload this folder (without `node_modules` or `dist`).
2. In Vercel: **Add New → Project → Import** that repository.
3. Vercel detects Vite. Keep the defaults (build `npm run build`, output `dist`) and click **Deploy**.

**Or from a computer with Node installed:** run `npx vercel --prod` inside this folder.

Keep it as its own Vercel project, separate from the current leaderboard site, until
you're ready to switch members over.

## Tests

`tests/ui-test.mjs` walks every login path in a real browser with Supabase responses
simulated: new member, existing member, wrong password, forgot password, log out,
session surviving a reload, and the layout at 320px wide. It uses made-up numbers.

```bash
npm run build && npx vite preview --port 4173 &
node tests/ui-test.mjs ./screenshots
```

## Data freshness

Totals come from the Google Sheet run tracker, synced into Supabase every Monday
at 8:45am by a scheduled task. The home screen says so.
