// Rasterises the scorecard SVG to PNG so chat channels can send a real image.
//
// sharp is an optional dependency on purpose: if it is missing or fails to
// load, we return null and every caller falls back to the text report. A
// missing image renderer must never cost you the demo.
let sharp = null;
let attempted = false;
let reason = '';

async function loadSharp() {
  if (attempted) return sharp;
  attempted = true;
  try {
    sharp = (await import('sharp')).default;
  } catch (error) {
    reason = error.message;
    console.warn('[render] sharp unavailable — chat will send text only:', reason.split('\n')[0]);
  }
  return sharp;
}

/** @returns {Promise<Buffer|null>} PNG bytes, or null if rendering is unavailable. */
export async function svgToPng(svg, { width = 1080 } = {}) {
  const renderer = await loadSharp();
  if (!renderer) return null;
  try {
    return await renderer(Buffer.from(svg), { density: 200 })
      .resize({ width, fit: 'inside', withoutEnlargement: false })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch (error) {
    console.warn('[render] PNG render failed, falling back to text:', error.message);
    return null;
  }
}

export const renderAvailable = async () => Boolean(await loadSharp());
