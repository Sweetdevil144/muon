/** Distance from the bottom (px) that still counts as "following" the stream. */
export const NEAR_BOTTOM_PX = 80;

/** True when the scroll container is at/near its bottom edge. */
export function isNearBottom(
  el: HTMLElement,
  thresholdPx: number = NEAR_BOTTOM_PX
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}
