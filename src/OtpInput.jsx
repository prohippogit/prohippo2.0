/* ProHippo — 6-digit one-time-code input (auto-advance, paste, SMS autofill) */
import React from "react";

const LEN = 6;

export default function OtpInput({ value, onChange, onComplete, disabled, autoFocus = true }) {
  const refs = React.useRef([]);
  const digits = String(value || "").padEnd(LEN).slice(0, LEN).split("");

  React.useEffect(() => {
    if (autoFocus && refs.current[0]) refs.current[0].focus();
  }, [autoFocus]);

  const setAt = (i, ch) => {
    const next = digits.map((d, idx) => (idx === i ? ch : d)).join("").replace(/\s/g, "");
    onChange(next);
    return next;
  };

  const handleChange = (i, e) => {
    const raw = e.target.value.replace(/\D/g, "");
    if (!raw) { setAt(i, " "); return; }
    // Handle autofill / fast typing that lands multiple digits in one box.
    if (raw.length > 1) {
      const filled = (digits.join("").slice(0, i) + raw).replace(/\s/g, "").slice(0, LEN);
      onChange(filled);
      const nextIdx = Math.min(filled.length, LEN - 1);
      refs.current[nextIdx]?.focus();
      if (filled.length === LEN) onComplete?.(filled);
      return;
    }
    const next = setAt(i, raw);
    if (i < LEN - 1) refs.current[i + 1]?.focus();
    if (next.replace(/\s/g, "").length === LEN) onComplete?.(next.replace(/\s/g, ""));
  };

  const handleKeyDown = (i, e) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (digits[i] && digits[i] !== " ") {
        setAt(i, " ");
      } else if (i > 0) {
        setAt(i - 1, " ");
        refs.current[i - 1]?.focus();
      }
    } else if (e.key === "ArrowLeft" && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === "ArrowRight" && i < LEN - 1) {
      refs.current[i + 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, LEN);
    if (!pasted) return;
    onChange(pasted);
    const nextIdx = Math.min(pasted.length, LEN - 1);
    refs.current[nextIdx]?.focus();
    if (pasted.length === LEN) onComplete?.(pasted);
  };

  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center" }} onPaste={handlePaste}>
      {Array.from({ length: LEN }).map((_, i) => (
        <input
          key={i}
          ref={(el) => (refs.current[i] = el)}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={i === 0 ? LEN : 1}
          value={digits[i] === " " ? "" : digits[i]}
          disabled={disabled}
          onChange={(e) => handleChange(i, e)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onFocus={(e) => e.target.select()}
          aria-label={`Digit ${i + 1}`}
          style={{
            width: 46,
            height: 54,
            textAlign: "center",
            fontSize: 22,
            fontWeight: 700,
            color: "var(--p-text)",
            border: "1px solid var(--p-line-2, #E3DEF0)",
            borderRadius: 12,
            background: disabled ? "var(--p-card-tint, #F7F6FB)" : "#fff",
            outlineColor: "var(--p-primary, #6C4CE0)",
          }}
        />
      ))}
    </div>
  );
}
