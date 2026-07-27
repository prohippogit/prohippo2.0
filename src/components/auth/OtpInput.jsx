import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './OtpInput.css';

/**
 * Parent-owned status driving the animation.
 * @typedef {'idle' | 'verifying' | 'success' | 'error'} OtpStatus
 */

const MERGE_MS = 340;
const SETTLE_MS = 900;
const ERROR_CLEAR_MS = 620;

/**
 * OTP entry with a converge-to-one success morph.
 *
 * Uses ONE transparent input stretched over rendered boxes rather than N
 * inputs. This is deliberate: it preserves iOS SMS autofill via
 * autoComplete="one-time-code", makes paste work natively, and avoids
 * hand-managing focus on backspace.
 *
 * The parent owns `status` — this component never decides whether a code is
 * correct, it only animates the answer.
 *
 * NOTE FOR CALLERS: the status effect below depends on `onChange` and
 * `onSuccessSettled` and clears its timers when it re-runs. Pass callbacks with
 * a stable identity (useCallback), or any unrelated re-render in the parent
 * will reschedule the success/error timers and make the timings drift.
 *
 * @param {object} props
 * @param {number} [props.length] Number of digits. 6 for Indian SMS/email OTP.
 * @param {OtpStatus} [props.status] Parent-owned status. Drives the merge and shake animations.
 * @param {(code: string) => void} props.onComplete Fires when the user has entered `length` digits.
 * @param {(code: string) => void} [props.onChange] Fires on every keystroke.
 * @param {() => void} [props.onSuccessSettled] Called after the success animation finishes settling.
 * @param {boolean} [props.autoFocus] Focus the field on mount.
 * @param {string} [props.className]
 */
export default function OtpInput({
  length = 6,
  status = 'idle',
  onComplete,
  onChange,
  onSuccessSettled,
  autoFocus = true,
  className = '',
}) {
  const [code, setCode] = useState('');
  const [focused, setFocused] = useState(false);
  const [merging, setMerging] = useState(false);
  const [settled, setSettled] = useState(false);
  const inputRef = useRef(null);
  const timers = useRef([]);

  const survivor = Math.floor((length - 1) / 2);

  const later = useCallback((fn, ms) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  const clearTimers = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // React to parent-driven status changes
  useEffect(() => {
    clearTimers();

    if (status === 'success') {
      setMerging(true);
      later(() => setSettled(true), MERGE_MS + 60);
      later(() => onSuccessSettled?.(), SETTLE_MS);
    }

    if (status === 'error') {
      setMerging(false);
      setSettled(false);
      later(() => {
        setCode('');
        onChange?.('');
        inputRef.current?.focus();
      }, ERROR_CLEAR_MS);
    }

    if (status === 'idle') {
      setMerging(false);
      setSettled(false);
    }
  }, [status, later, clearTimers, onChange, onSuccessSettled]);

  const locked = status === 'verifying' || status === 'success';

  const handleChange = (e) => {
    if (locked) {
      e.target.value = code;
      return;
    }
    const next = e.target.value.replace(/\D/g, '').slice(0, length);
    setCode(next);
    onChange?.(next);
    if (next.length === length) onComplete(next);
  };

  const offsets = useMemo(
    () =>
      Array.from({ length }, (_, i) => ((length - 1) / 2 - i) * 56), // (box width 46 + gap 10)
    [length],
  );

  return (
    <div className={`otp ${className}`}>
      <div className="otp__stage">
        {settled && <div className="otp__glow" />}

        <div
          className="otp__boxes"
          data-merge={merging}
          data-verifying={status === 'verifying'}
          data-shake={status === 'error'}
          onClick={() => inputRef.current?.focus()}
        >
          {Array.from({ length }).map((_, i) => {
            const char = code[i];
            const isSurvivor = i === survivor;
            const isActive =
              focused &&
              status === 'idle' &&
              !char &&
              i === Math.min(code.length, length - 1);

            return (
              <div
                key={i}
                className="otp__box"
                style={{ '--otp-dx': `${offsets[i]}px` }}
                data-filled={Boolean(char)}
                data-active={isActive}
                data-error={status === 'error'}
                data-survivor={isSurvivor}
              >
                {settled && isSurvivor ? (
                  <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
                    <path className="otp__tick" d="M5 12.5 L10 17.5 L19 7.5" />
                  </svg>
                ) : merging ? null : char ? (
                  <span className="otp__digit" key={`${char}-${i}`}>
                    {char}
                  </span>
                ) : isActive ? (
                  <span className="otp__caret" />
                ) : null}
              </div>
            );
          })}

          <input
            ref={inputRef}
            className="otp__input"
            value={code}
            onChange={handleChange}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={length}
            disabled={locked}
            aria-label={`${length} digit verification code`}
            aria-invalid={status === 'error'}
          />
        </div>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {status === 'verifying' && 'Checking your code'}
        {status === 'success' && 'Verified'}
        {status === 'error' && 'That code is not right'}
      </span>
    </div>
  );
}
