/**
 * Controller pictures for the Overview page and the sidebar: a trimmed product
 * photo per supported pad, over a soft glow in that pad's colour. Pads we
 * don't support have no picture. The Saber Plus and Xeno Pro share one model
 * (SaberPlus) but each has its own picture, told apart by the detected name.
 */

interface Pictured { name: string; src: string; tint: string }

const PADS: Record<string, Pictured> = {
  G7ProCE: { name: 'GameSir G7 Pro 8K', src: new URL('./assets/controllers/G7ProCE.webp', import.meta.url).href, tint: '#e8b84a' },
  T3CE: { name: 'GameSir Tarantula 8K', src: new URL('./assets/controllers/T3CE.webp', import.meta.url).href, tint: '#f97316' },
  XenoPro: { name: 'LeadJoy Xeno Pro', src: new URL('./assets/controllers/XenoPro.webp', import.meta.url).href, tint: '#b98cff' },
  SaberPlus: { name: 'LeadJoy Saber Plus', src: new URL('./assets/controllers/SaberPlus.webp', import.meta.url).href, tint: '#ec4899' },
  HyperStrike: { name: 'HyperStrike', src: new URL('./assets/controllers/HyperStrike.webp', import.meta.url).href, tint: '#38bdf8' }
}

/** Picture key for a model; the shared LeadJoy model picks by its detected name. */
export function pictureKey(modelId: string, detectedName?: string | null): string | null {
  if (modelId === 'SaberPlus') return detectedName?.includes('Saber Plus') ? 'SaberPlus' : 'XenoPro'
  return modelId in PADS ? modelId : null
}

/** Every supported pad, in display order. */
export const SUPPORTED_PADS = Object.entries(PADS).map(([key, p]) => ({ key, name: p.name }))

export function ControllerArt({ pad, className }: { pad: string | null; className?: string }): JSX.Element | null {
  const photo = pad ? PADS[pad] : undefined
  if (!photo) return null
  return (
    <div className={['controller-art', 'controller-photo', className].filter(Boolean).join(' ')} style={{ '--dev': photo.tint } as React.CSSProperties} aria-hidden="true">
      <img src={photo.src} alt="" draggable={false} />
    </div>
  )
}
