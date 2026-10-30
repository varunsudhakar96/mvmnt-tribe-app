import { useRef, useState } from 'react';
import { useEffect } from 'react';
import { checkPhone, createAccount, logIn, sendCode, verifyCode, normalisePhone, formatPhone, messageFor } from './api.js';
import { ADMIN_WHATSAPP } from './config.js';
import Wordmark from './Wordmark.jsx';

// Steps: 'phone' -> 'password' (has an account) or 'create' (member without one, or new).
// With WhatsApp codes on: 'create' -> 'code' (verify the number), and 'password' offers a code
// login or a self-service reset, both through 'code'.
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
  const [otp, setOtp] = useState(false);
  const [purpose, setPurpose] = useState(null);
  const [code, setCode] = useState('');
  const [resendIn, setResendIn] = useState(0);
  const [info, setInfo] = useState('');
  const passwordRef = useRef(null);
  const codeRef = useRef(null);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

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
      const { status: s, otp: on } = await checkPhone(phone);
      setStatus(s);
      setOtp(on);
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
    if (otp) return run(() => startCode('signup'));
    run(() => createAccount({ phone, password, name: status === 'new' ? name : undefined }));
  };

  async function startCode(p) {
    await sendCode(phone, p);
    setPurpose(p);
    setCode('');
    if (p === 'reset') { setPassword(''); setConfirm(''); }
    setResendIn(30);
    setInfo('');
    setStep('code');
    setTimeout(() => codeRef.current?.focus(), 50);
  }

  const resend = () => run(async () => {
    await sendCode(phone, purpose);
    setResendIn(30);
    setCode('');
    setInfo('New code sent.');
  });

  const submitCode = (e) => {
    e.preventDefault();
    if (code.length !== 6) return setError('Enter the 6-digit code.');
    if (purpose === 'reset') {
      if (password.length < 6) return setError(messageFor('password_too_short'));
      if (password !== confirm) return setError("Those passwords don't match.");
    }
    run(async () => {
      try {
        await verifyCode({ phone, purpose, code, password, name: status === 'new' ? name : undefined });
      } catch (err) {
        if (err.code === 'wrong_otp' && err.triesLeft != null) {
          setCode('');
          throw Object.assign(err, { code: err.triesLeft > 0 ? 'wrong_otp' : 'too_many_attempts' });
        }
        throw err;
      }
    });
  };

  function changeNumber() {
    setStep('phone');
    setPassword('');
    setConfirm('');
    setError('');
    setForgotOpen(false);
    setCode('');
    setPurpose(null);
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

          {otp ? (
            <>
              <div className="or-line"><span>or</span></div>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => startCode('login'))}>
                Send me a WhatsApp code
              </button>
              <button type="button" className="link" disabled={busy} onClick={() => run(() => startCode('reset'))}>
                Forgot password? Reset it with a code
              </button>
            </>
          ) : (
            <>
              <button type="button" className="link" onClick={() => setForgotOpen((o) => !o)} aria-expanded={forgotOpen}>
                Forgot password?
              </button>
              {forgotOpen && <ForgotNote phone={phone} />}
            </>
          )}
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
            {busy ? (otp ? 'Sending code…' : 'Creating your account…') : (otp ? 'Send WhatsApp code' : 'Create account')}
          </button>
          {otp && <p className="hint center">We'll send a code to this number on WhatsApp to confirm it's yours.</p>}
        </form>
      )}

      {step === 'code' && (
        <form className="stack" onSubmit={submitCode} noValidate>
          <div>
            <h1 className="display">{purpose === 'reset' ? 'Reset your password.' : 'Check WhatsApp.'}</h1>
            <p className="lede">We sent a 6-digit code to <strong>+91 {formatPhone(phone)}</strong>. It works for 5 minutes.</p>
          </div>
          <div className="field">
            <label htmlFor="otp">Code</label>
            <input
              id="otp"
              ref={codeRef}
              className="input otp-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="••••••"
              maxLength={6}
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); setInfo(''); }}
            />
          </div>
          {purpose === 'reset' && (
            <>
              <PasswordField id="reset-password" label="New password" hint="At least 6 characters." value={password}
                onChange={(v) => { setPassword(v); setError(''); }} show={showPassword}
                onToggle={() => setShowPassword((x) => !x)} autoComplete="new-password" />
              <PasswordField id="reset-confirm" label="Type it again" value={confirm}
                onChange={(v) => { setConfirm(v); setError(''); }} show={showPassword} autoComplete="new-password" />
            </>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          {info && !error && <p className="saved" role="status">{info}</p>}
          <button className="btn" type="submit" disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : purpose === 'signup' ? 'Confirm and create account' : purpose === 'reset' ? 'Set new password' : 'Log in'}
          </button>
          <div className="row center-row">
            <button type="button" className="link inline" onClick={resend} disabled={busy || resendIn > 0}>
              {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
            </button>
            <button type="button" className="link inline" onClick={() => { setStep(purpose === 'signup' ? 'create' : 'password'); setError(''); }}>
              Back
            </button>
          </div>
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
