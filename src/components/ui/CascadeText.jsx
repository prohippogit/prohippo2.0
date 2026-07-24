/* CascadeText — a per-character "roll up and recolour" reveal.
   Adapted from the shadcn `cascade-text` (TextReveal) component to this
   project's stack (React JSX + plain CSS; no Tailwind/TS). Each grapheme
   carries a textShadow duplicate one em away; on reveal the glyph rolls
   out of a 1em window while its coloured duplicate rolls in, staggered
   per character.

   Reveal can be self-managed (hover) or controlled via the `hovered`
   prop, so several instances can animate as one headline. `startIndex`
   offsets the stagger so a multi-part line cascades continuously. */
import { useMemo, useState } from "react";

export function CascadeText({
  text,
  as: Component = "span",
  className = "",
  style,
  fontSize = "inherit",
  staggerDelay = 25,
  duration = 260,
  easing = "cubic-bezier(0.16, 1, 0.3, 1)",
  color = "inherit",
  hoverColor = "#6d55e7",
  direction = "up",
  hovered: hoveredProp,
  startIndex = 0,
  ariaLabel,
}) {
  const [hoveredState, setHoveredState] = useState(false);
  const controlled = hoveredProp !== undefined;
  const hovered = controlled ? hoveredProp : hoveredState;

  const chars = useMemo(() => {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
      return Array.from(segmenter.segment(text), (s) => s.segment);
    }
    return [...text];
  }, [text]);

  const sign = direction === "up" ? 1 : -1;

  const handlers = controlled
    ? {}
    : {
        onMouseEnter: () => setHoveredState(true),
        onMouseLeave: () => setHoveredState(false),
      };

  return (
    <Component
      className={`cascade-text ${className}`.trim()}
      style={{ fontSize, color: hovered ? hoverColor : color, transition: "color 0.35s ease", ...style }}
      aria-label={ariaLabel ?? text}
      {...handlers}
    >
      <span className="cascade-inner" aria-hidden="true">
        {chars.map((char, i) => (
          <span
            key={i}
            className="cascade-char"
            style={{
              textShadow: `0 ${sign}em currentColor`,
              transition: `transform ${duration}ms ${easing}`,
              transitionDelay: `${(startIndex + i) * staggerDelay}ms`,
              transform: hovered ? `translateY(${-sign}em)` : "translateY(0)",
            }}
          >
            {char === " " ? " " : char}
          </span>
        ))}
      </span>
    </Component>
  );
}

export default CascadeText;
