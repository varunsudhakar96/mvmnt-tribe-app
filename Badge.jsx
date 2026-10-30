// Badges are the only colour in the app.
const TIER_KM = { PACER: 25, STRIDER: 50, RANGER: 100, WAYFARER: 200, VOYAGER: 300 };

export default function Badge({ tier, size = 76 }) {
  const t = tier && TIER_KM[tier] ? tier.toLowerCase() : 'none';
  return (
    <div className={`medal medal-${t}`} style={{ width: size, height: size }} aria-hidden="true">
      <div className="medal-face">
        {tier && TIER_KM[tier] ? (
          <>
            <span className="medal-km">{TIER_KM[tier]}</span>
            <span className="medal-unit">KM</span>
          </>
        ) : (
          <span className="medal-unit">—</span>
        )}
      </div>
    </div>
  );
}
