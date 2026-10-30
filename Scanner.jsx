import { useEffect, useRef } from 'react';
import jsQR from 'jsqr';

// Live camera QR reader. Works in Safari and Chrome on phones (needs https).
export default function Scanner({ onResult, onError }) {
  const video = useRef(null);
  const done = useRef(false);

  useEffect(() => {
    let stream;
    let raf;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function tick() {
      const v = video.current;
      if (done.current || !v) return;
      if (v.readyState >= 2 && v.videoWidth) {
        const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data) {
          done.current = true;
          if (navigator.vibrate) navigator.vibrate(60);
          stop();
          onResult(code.data);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    }

    function stop() {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      onError('camera_unavailable');
      return undefined;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        stream = s;
        if (done.current) { stop(); return; }
        const v = video.current;
        v.srcObject = s;
        v.setAttribute('playsinline', '');
        v.muted = true;
        v.play().catch(() => {});
        raf = requestAnimationFrame(tick);
      })
      .catch((err) => {
        onError(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'camera_denied' : 'camera_unavailable');
      });

    return () => { done.current = true; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scanner">
      <video ref={video} playsInline muted aria-label="Camera view" />
      <div className="scan-frame" aria-hidden="true"><span /><span /><span /><span /></div>
    </div>
  );
}
