export type CenterDirection = 'left' | 'right' | 'up' | 'down'

/** GameSir Connect 1.16.7 G7ProCE: one directional nudge, magnitude 32. */
export function centerNudge(side: number, direction: CenterDirection): number[] {
  const directions = { left: 0, right: 1, up: 2, down: 3 }
  if (side !== 0 && side !== 1) throw new Error('Select left or right stick.')
  if (!Object.prototype.hasOwnProperty.call(directions, direction)) throw new Error('Invalid center direction.')
  const report = Array<number>(64).fill(0)
  report.splice(0, 6, 0x0f, 0xe2, side, directions[direction], 0, 32)
  return report
}

/** G7ProCE Original axes: high bytes 54–57, low bytes 26–29. */
export function centerPreview(raw: Uint8Array): { lx: number; ly: number; rx: number; ry: number } | undefined {
  if (raw.length < 64 || raw[0] !== 0x12) return undefined
  const axis = (i: number): number => {
    const signed = ((raw[54 + i] << 8) | raw[26 + i]) - 32768
    return signed / (signed > 0 ? 32767 : 32768)
  }
  return { lx: axis(0), ly: axis(1), rx: axis(2), ry: axis(3) }
}

export function checkCenterAck(raw: Uint8Array): void {
  if (raw.length < 3 || raw[0] !== 0x10 || raw[1] !== 0xe3 || raw[2] !== 0) {
    throw new Error('Controller rejected center adjustment or returned an invalid reply.')
  }
}
