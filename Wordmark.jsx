import logo from './assets/logo.png';

// The Mvmnt Tribe logo (same artwork as the Fartlek timer), drawn in ink via a CSS mask.
export default function Wordmark({ small = false }) {
  return (
    <div
      className={small ? 'wordmark small' : 'wordmark'}
      role="img"
      aria-label="Mvmnt Tribe"
      style={{ '--logo': `url(${logo})` }}
    />
  );
}
