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

## Pages

- **Home (`#/`)**, public: "Let's get stronger together." and the upcoming runs. Logged out it shows
  *Log in*; logged in it shows the runner's profile photo (or initials), which opens **Your runs
  (`#/me`)**: km, runs, rank, badge, recent runs, photo upload, Admin (organisers) and Log out.
- **Log in (`#/login`)**.
- **Run pages (`#/run/<id>`)** are public and have a **Share** button (phone share sheet, or copies
  the link). Organisers also get Share on each run's admin page.
- Profile photos go to the public `avatars` storage bucket; each member can only write to their own
  folder, and `set_my_avatar()` only accepts their own photo's address.

## Upcoming runs, sign-ups and check-in

- **Run pages are public.** Anyone with the link (e.g. shared on WhatsApp) can see the poster,
  date, time, venue and details without logging in. Signing up and attending need a login;
  tapping either takes them to log in and then straight back to where they were going.
- **Sign up happens in the app.** Name and number come from their login. Each run can have its
  own extra questions (short answer, paragraph, number, multiple choice, yes/no; optional or
  required) and an optional spots limit. After signing up they see a "You're in" screen; the run
  page then shows "You're signed up", their answers, *Change answers* and *Can't make it?* (cancel).
- **Attend run** shows greyed out for signed-up runners until run day, then opens the camera.
  Scanning the venue QR opens the in-app check-in: the run's distance is filled in, they adjust it
  if needed and tap *Log my run*. The run goes straight into their totals and the leaderboard, and
  a new badge is announced on the spot. Scanning again the same day fixes the distance (never a
  second run). Scanning with the phone's own camera app works too.
- **Organisers** see who checked in on each run, can add someone who couldn't scan (by number),
  and remove mistakes. Check-ins are stored as `activities` with detail `app check-in` /
  `admin check-in`; the weekly sheet sync skips sheet rows for anyone already checked in that day.
- **The venue QR** is made per run in the admin panel (Download QR). It only works on that run's
  day and only for that run. *Make a new code* kills the old one if a photo of it gets shared.

## Admin panel

Log in with an organiser account and tap **Admin** (top right). Add, edit or delete runs: poster,
name, date, start time, venue, Maps link, details, the sign-up form (open/closed, spots, questions)
and the attend form link. Each run shows who signed up with their answers, and *Download list (CSV)*
opens in Excel or Google Sheets. New runs start with the previous run's questions.
Organisers are members with `is_admin = true`:

```sql
update public.members set is_admin = true where sheet_key = '98XXXXXXXX';
```

Posters go to the public `run-posters` storage bucket (only organisers can upload). Runs are stored
in the `events` table with category `weekend_run`.

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
node tests/ui-test.mjs ./screenshots          # login + home
node tests/make-fixtures.mjs tests/fixtures   # needs ffmpeg: fake camera feed + poster
node tests/runs-test.mjs ./screenshots        # runs, real QR scanning via a fake camera, admin
```

## Public leaderboard

The leaderboard site reads `public_leaderboard()` (names, km, runs, badge; no numbers), so it is
live. Its code lives in the separate leaderboard project.

## Data freshness

Totals come from the Google Sheet run tracker, synced into Supabase every Monday
at 8:45am by a scheduled task. The home screen says so.
