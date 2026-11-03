import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { runDetail, ticketLink, messageFor, runDate, runTime } from './api.js';
import { href } from './router.js';

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const when = (r) => [runDate(r.date, { weekday: 'long', day: 'numeric', month: 'long' }), runTime(r.time)].filter(Boolean).join(' · ');

// The ticket: name, event, a QR the organiser scans, and the code in case the camera can't.
export function Ticket({ run, name, onDone, backHref }) {
  const [qr, setQr] = useState('');
  const [png, setPng] = useState(null); // the ticket as an image, ready before the tap so the share sheet opens straight away
  const [canShare, setCanShare] = useState(false);
  const [saved, setSaved] = useState('');
  const code = run.my_ticket;
  const venueDue = run.my_payment === 'venue' && run.price > 0;
  const paid = run.price > 0 && run.my_payment === 'confirmed';
  const scanMode = run.checkin_mode === 'ticket' || run.checkin_mode === 'both';

  useEffect(() => {
    if (!code) return;
    QRCode.toDataURL(ticketLink(code), { width: 640, margin: 1, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(''));
  }, [code]);

  // Build the ticket image as soon as the QR is ready.
  useEffect(() => {
    if (!qr) return;
    let dead = false;
    (async () => {
      try {
        const img = new Image(); img.src = qr; await img.decode();
      const W = 1080, H = 1500;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#0a0a0a';
      g.font = '800 40px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textAlign = 'left';
      g.fillText('MVMNT TRIBE · TICKET', 80, 110);
      g.font = '900 86px "Barlow Condensed", "Arial Narrow", sans-serif';
      wrap(g, run.name.toUpperCase(), 80, 210, W - 160, 88, 2);
      g.font = '500 40px Barlow, Arial, sans-serif'; g.fillStyle = '#6b6b6b';
      g.fillText(when(run), 80, 420);
      if (run.venue) g.fillText(run.venue, 80, 475);
      g.fillStyle = '#0a0a0a'; g.font = '700 46px Barlow, Arial, sans-serif';
      g.fillText(name || '', 80, 560);
      g.drawImage(img, 240, 620, 600, 600);
      g.textAlign = 'center';
      g.font = '800 54px "Barlow Condensed", "Arial Narrow", sans-serif';
      g.fillText(code, W / 2, 1300);
      g.font = '500 32px Barlow, Arial, sans-serif'; g.fillStyle = '#6b6b6b';
      g.fillText(run.my_test ? 'TEST TICKET · not a real booking' : venueDue ? `Pay ${rupees(run.price)} at the venue` : paid ? `Paid ${rupees(run.price)}` : 'Show this at the door', W / 2, 1360);
      g.fillText('mvmnttribe', W / 2, 1440);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (!dead && blob) {
        const file = new File([blob], `ticket-${run.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`, { type: 'image/png' });
        setPng(file);
        setCanShare(!!navigator.share && !!navigator.canShare && navigator.canShare({ files: [file] }));
      }
      } catch { /* the on-screen ticket still works; the button will say so */ }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr]);

  async function save() {
    if (!png) { setSaved("Couldn't make the image. Take a screenshot instead."); return; }
    try {
      if (canShare) {
        // Opens the phone's share sheet: AirDrop, WhatsApp, Save Image, etc.
        await navigator.share({ files: [png], title: `Ticket · ${run.name}` });
        return;
      }
      const url = URL.createObjectURL(png);
      const a = document.createElement('a'); a.href = url; a.download = png.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setSaved('Downloaded');
      setTimeout(() => setSaved(''), 2500);
    } catch (e) {
      if (e?.name === 'AbortError') return; // they closed the share sheet
      setSaved("Couldn't share. Take a screenshot instead.");
    }
  }

  return (
    <main className="shell ticket-shell">
      {backHref && <header className="topbar"><a className="link back" href={backHref}>‹ Back</a></header>}
      <section className="ticket" aria-label="Your ticket">
        <div className="ticket-head">
          <p className="eyebrow">{onDone ? "You're in" : 'Your ticket'}</p>
          <h1 className="display">{run.name}</h1>
          <p className="muted">{when(run)}{run.venue ? ` · ${run.venue}` : ''}</p>
        </div>
        <div className="ticket-tear" aria-hidden="true" />
        <div className="ticket-body">
          <p className="ticket-name">{name}</p>
          {qr ? <img className="ticket-qr" src={qr} alt={`Ticket QR, code ${code}`} /> : <div className="ticket-qr blank" />}
          <p className="ticket-code" aria-label="Ticket code">{code}</p>
          {run.my_test && <p className="preview-banner ticket-note">Test ticket · not a real booking</p>}
          {venueDue && <p className="pending-banner ticket-note">Pay {rupees(run.price)} at the venue</p>}
          {paid && <p className="signed-banner ticket-note"><span aria-hidden="true">✓</span> Paid {rupees(run.price)}</p>}
          <p className="hint center">
            {scanMode
              ? 'Show this at the door. The organiser scans it to check you in.'
              : 'Keep this as proof of your spot. On the day, scan the venue QR to check in.'}
          </p>
        </div>
      </section>
      <div className="stack tight">
        <button className="btn" onClick={save} disabled={!png}>{canShare ? 'Save or share ticket' : 'Save as image'}</button>
        {saved && <p className="saved center" role="status">{saved}</p>}
        {onDone && <button className="btn ghost" onClick={onDone}>Done</button>}
      </div>
    </main>
  );
}

function wrap(g, text, x, y, maxW, lineH, maxLines) {
  const words = text.split(' '); let line = ''; let n = 0;
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > maxW && line) {
      g.fillText(line, x, y + n * lineH); n += 1; line = w;
      if (n === maxLines - 1) { line = `${line}…`; break; }
    } else line = t;
  }
  g.fillText(line, x, y + n * lineH);
}

// #/run/:id/ticket — the ticket for a sign-up already made.
export default function TicketPage({ id, profile }) {
  const [run, setRun] = useState(undefined);
  const [error, setError] = useState('');
  useEffect(() => { runDetail(id).then(setRun).catch((e) => setError(messageFor(e.code))); }, [id]);
  if (error || run === null) {
    return <main className="shell"><header className="topbar"><a className="link back" href={href(`run/${id}`)}>‹ Back</a></header><p className="error" role="alert">{error || messageFor('run_not_found')}</p></main>;
  }
  if (!run) return <main className="shell"><p className="muted">Loading…</p></main>;
  if (!run.my_ticket) {
    return (
      <main className="shell">
        <header className="topbar"><a className="link back" href={href(`run/${id}`)}>‹ Back</a></header>
        <p className="muted">You haven't signed up for this one yet.</p>
      </main>
    );
  }
  return <Ticket run={run} name={profile?.name} backHref={href(`run/${id}`)} />;
}

// #/ticket/:code — what a ticket QR opens. Organisers get sent to the scanner; anyone else just sees what it is.
export function TicketLanding({ code, profile }) {
  if (profile?.is_admin) {
    window.location.replace(`#/admin/scan?t=${encodeURIComponent(code)}`);
    return null;
  }
  return (
    <main className="shell">
      <header className="topbar"><a className="link back" href={href('')}>‹ Home</a></header>
      <h1 className="display">Event ticket</h1>
      <p className="lede">This QR is someone's ticket for a Mvmnt Tribe event. The organiser scans it at the door to check them in.</p>
    </main>
  );
}
