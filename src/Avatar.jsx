// Profile photo, or initials when there isn't one.
export default function Avatar({ name, url, size = 40 }) {
  const initials = String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return url ? (
    <img className="avatar" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} />
  ) : (
    <span className="avatar initials" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials}</span>
  );
}
