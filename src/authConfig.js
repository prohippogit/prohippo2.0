/*
 * ProHippo — sign-in method configuration.
 *
 * One place to control which login methods appear, and which is the primary
 * (hero) method on the sign-in screen. Email OTP is live today; SMS OTP is
 * built but waits on the DLT header PRHIPO going active on 2Factor.
 *
 * To turn SMS on (once PRHIPO is active and tested):
 *   1. set `sms: true` below, and
 *   2. set `CHANNEL_ENABLED.sms = true` + implement sendSmsOtp() in functions/index.js.
 * When `sms` is true it automatically becomes the top, primary method and
 * email drops to secondary — no other UI change needed.
 */
export const AUTH_METHODS = {
  sms: false, // SMS OTP — the intended PRIME method; enable when PRHIPO is live
  emailOtp: true, // Email OTP via Resend — live now
  google: true, // Google — kept as a fallback during rollout
  magicLink: false, // legacy email magic-link — superseded by Email OTP
};

// The primary (hero) channel: SMS when enabled, otherwise Email OTP.
export const PRIMARY_CHANNEL = AUTH_METHODS.sms ? "sms" : "email";
