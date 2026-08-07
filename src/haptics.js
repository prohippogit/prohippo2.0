/* ProHippo — touch feedback.
 *
 * A phone confirming a tap with a 10 ms buzz is the difference between "did
 * that register?" and knowing it did. On a practitioner standing outside a
 * hearing room, thumbing through notices one-handed, that is most of what
 * "feels like an app" means.
 *
 * WHAT ACTUALLY WORKS, STATED PLAINLY BECAUSE IT SHAPES EVERYTHING BELOW:
 *
 *   Android Chrome     navigator.vibrate — real, reliable, what this uses.
 *   iOS Safari         NOT SUPPORTED. Apple has never shipped the Vibration
 *                      API and shows no sign of doing so, in the browser or in
 *                      a standalone PWA. There is a known trick — an offscreen
 *                      <input type="checkbox" switch> whose toggle Apple gives
 *                      a system haptic — but it is undocumented, silently
 *                      broken by point releases, and needs a real user gesture
 *                      on the input itself. It is not in here: a feature that
 *                      works until an iOS update is worse than one that never
 *                      claimed to.
 *
 * So on iPhone this is a no-op, and every other part of the mobile work has to
 * carry its own weight — which is why the CSS gives every tappable thing a
 * press state that is visible rather than only felt.
 *
 * THE PATTERNS ARE DELIBERATELY SHORT. 10 ms is a tick, not a buzz; anything
 * a user would describe as "vibrating" is an alert, and this is not alerting
 * anybody. The heaviest thing here is 30 ms, reserved for a genuine failure.
 */

/* Off if the device cannot, if the user asked for less motion, or if the
   practice switched it off (profile.haptics === false). Read lazily, so
   toggling the setting takes effect without a reload. */
let enabled = true;

/** Called by the store when the profile loads or changes. */
export function setHapticsEnabled(on) {
  enabled = on !== false;
}

const supported = () =>
  typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

/* Someone who has asked the OS to reduce motion has usually also had enough of
   things buzzing at them. Checked at call time rather than cached: the setting
   can change while the app is open. */
const reduced = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function buzz(pattern) {
  if (!enabled || reduced() || !supported()) return false;
  try {
    return navigator.vibrate(pattern);
  } catch {
    // Some Androids throw inside an iframe or before a user gesture. Never let
    // feedback break the action it was decorating.
    return false;
  }
}

/** A control was pressed. The default, and by far the most common. */
export const tap = () => buzz(8);

/** A choice was made — a tab, a filter, a segmented control. */
export const select = () => buzz(12);

/** Something completed: saved, sent, synced. Two light ticks. */
export const success = () => buzz([12, 40, 12]);

/** Something needs looking at, but nothing broke. */
export const warn = () => buzz([18, 60, 18]);

/** Something failed. The only pattern anyone would call a buzz. */
export const error = () => buzz(30);

/** A list crossed the pull-to-refresh threshold and will fire on release. */
export const threshold = () => buzz(14);

/* Whether a buzz would actually happen. The Settings toggle uses this to say
   so honestly on a device that cannot, rather than offering a switch that
   controls nothing. */
export const hapticsAvailable = () => supported();
