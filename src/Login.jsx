import { useRef, useState } from 'react';
import { checkPhone, createAccount, logIn, normalisePhone, formatPhone, messageFor } from './api.js';
import { ADMIN_WHATSAPP } from './config.js';
import Wordmark from './Wordmark.jsx';

// Steps: 'phone' -> 'password' (has an account) or 'create' (member without one, or new)
export default function Login({ backHref = null, note = null }) {
  const [step, setStep] = useState('phone');
  const [digits, setDigits] = useState('');
  const [status, setStatus] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const passwordRef = useRef(null);

  const phone = normalisePhone(digits);

  function onPhoneInput(e) {
    let d = e.target.value.replace(/\D/g, '');
    if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
    if (d.length > 10 && d.startsWith('0')) d = d.slice(1);
    setDigits(d.slice(0, 10));
    setError('');
  }

  async function run(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      if (err.code === 'has_account') {
        setStatus('has_account');
        setStep('password');
        setConfirm('');
      }
      setError(messageFor(err.code));
    } finally {
      setBusy(false);
    }
  }

  const submitPhone = (e) => {
    e.preventDefault();
    if (!phone) return setError(messageFor('invalid_phone'));
    run(async () => {
      const s = await checkPhone(phone);
      setStatus(s);
      setStep(s === 'has_account' ? 'password' : 'create');
      setTimeout(() => passwordRef.current?.focus(), 50);
    });
  };

  const submitLogin = (e) => {
    e.preventDefault();
    if (!password) return setError('Enter your password.');
    run(() => logIn({ phone, password }));
  };

  const submitCreate = (e) => {
    e.preventDefault();
    if (status === 'new' && name.trim().length < 2) return setError(messageFor('name_required'));
    if (password.length < 6) return setError(messageFor('password_too_short'));
    if (password !== confirm) return setError("Those passwords don't match.");
    run(() => createAccount({ phone, password, name: status === 'new' ? name : undefined }));
  };

  function changeNumber() {
    setStep('phone');
    setPassword('');
    setConfirm('');
    setError('');
    setForgotOpen(false);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <Wordmark small />
        {backHref && <a className="link" href={backHref}>‹ Back</a>}
      </header>
      {note && <p className="login-note">{note}</p>}

      {step === 'phone' && (
        <form className="stack" onSubmit={submitPhone} noValidate>
          <div>
            <h1 className="display">Your number<br />is your bib.</h1>
            <p className="lede">Log in with the WhatsApp number you run with.</p>
          </div>

          <label className="bib" htmlFor="phone">
            <span className="pin tl" /><span className="pin tr" /><span className="pin bl" /><span className="pin br" />
            <span className="bib-head">MVMNT TRIBE · WEEKEND RUNS</span>
            <input
              id="phone"
              className="bib-number"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="98765 43210"
              value={formatPhone(digits)}
              onChange={onPhoneInput}
              aria-label="Mobile number"
              aria-invalid={Boolean(error)}
              autoFocus
            />
            <span className="bib-foot">+91</span>
          </label>

          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={busy || !phone}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
      )}

      {step === 'password' && (
        <form className="stack" onSubmit={submitLogin} noValidate>
          <div>
            <h1 className="display">Welcome back.</h1>
            <NumberChip phone={phone} onChange={changeNumber} />
          </div>

          <PasswordField
            id="password"
            label="Password"
            value={password}
            onChange={(v) => { setPassword(v); setError(''); }}
            show={showPassword}
            onToggle={() => setShowPassword((s) => !s)}
            autoComplete="current-password"
            inputRef={passwordRef}
          />

          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Logging in…' : 'Log in'}
          </button>

          <button type="button" className="link" onClick={() => setForgotOpen((o) => !o)} aria-expanded={forgotOpen}>
            Forgot password?
          </button>
          {forgotOpen && <ForgotNote phone={phone} />}
        </form>
      )}

      {step === 'create' && (
        <form className="stack" onSubmit={submitCreate} noValidate>
          <div>
            {status === 'member' ? (
              <>
                <h1 className="display">Your runs are<br />already here.</h1>
                <p className="lede">Create a password to see your kilometres, badges and rank.</p>
              </>
            ) : (
              <>
                <h1 className="display">Welcome to<br />the Tribe.</h1>
                <p className="lede">Create your account. Your runs will start counting from your first Saturday.</p>
              </>
            )}
            <NumberChip phone={phone} onChange={changeNumber} />
          </div>

          {status === 'new' && (
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input
                id="name"
                className="input"
                autoComplete="name"
                placeholder="First and last name"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(''); }}
              />
            </div>
          )}

          <PasswordField
            id="new-password"
            label="Create a password"
            hint="At least 6 characters. You'll use it every time you log in."
            value={password}
            onChange={(v) => { setPassword(v); setError(''); }}
            show={showPassword}
            onToggle={() => setShowPassword((s) => !s)}
            autoComplete="new-password"
            inputRef={status === 'member' ? passwordRef : undefined}
          />
          <PasswordField
            id="confirm-password"
            label="Type it again"
            value={confirm}
            onChange={(v) => { setConfirm(v); setError(''); }}
            show={showPassword}
            autoComplete="new-password"
          />

          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Creating your account…' : 'Create account'}
          </button>
        </form>
      )}
    </main>
  );
}

function NumberChip({ phone, onChange }) {
  return (
    <p className="chip">
      <span>+91 {formatPhone(phone)}</span>
      <button type="button" className="link inline" onClick={onChange}>Change</button>
    </p>
  );
}

function PasswordField({ id, label, hint, value, onChange, show, onToggle, autoComplete, inputRef }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password">
        <input
          id={id}
          ref={inputRef}
          className="input"
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        {onToggle && (
          <button type="button" className="reveal" onClick={onToggle} aria-pressed={show}>
            {show ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {hint && <p className="hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

function ForgotNote({ phone }) {
  const text = encodeURIComponent(`Hi, I forgot my Mvmnt Tribe app password. My number is ${phone}.`);
  return (
    <div className="note">
      <p>
        Message the Mvmnt Tribe team on WhatsApp from this number and we'll reset it.
        Your runs and badges stay exactly as they are.
      </p>
      {ADMIN_WHATSAPP && (
        <a className="btn ghost" href={`https://wa.me/${ADMIN_WHATSAPP}?text=${text}`} target="_blank" rel="noreferrer">
          Message on WhatsApp
        </a>
      )}
    </div>
  );
}
