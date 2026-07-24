/* ProHippo — public landing page (shown before sign-in).
   Design: kinetic hero, a pinned horizontal "Notice -> Appeal" journey,
   a manifesto, a control section and a closing mascot card. */
import React from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import { CascadeText } from "@/components/ui/CascadeText";
import "./landing.css";
import logo from "./assets/landing/prohippo-logo.webp";
import heroScene from "./assets/landing/hero-notice-scene.webp";
import mascot from "./assets/landing/prohippo-mascot.webp";
import f01 from "./assets/landing/features/01-notice-issued.webp";
import f02 from "./assets/landing/features/02-email-unopened.webp";
import f03 from "./assets/landing/features/03-whatsapp-alert.webp";
import f04 from "./assets/landing/features/04-hearing-calendar.webp";
import f05 from "./assets/landing/features/05-hearing-reminder.webp";
import f06 from "./assets/landing/features/06-reply-submit.webp";
import f07 from "./assets/landing/features/07-order-countdown.webp";
import f08 from "./assets/landing/features/08-appeal-filed.webp";

gsap.registerPlugin(ScrollTrigger);

const JOURNEY = [
  { img: f01, variant: "fp-a", tag: "Notice detected",
    title: "The notice is issued.",
    body: "ProHippo starts watching the matter the moment a digital notice leaves the Income Tax Department.",
    alt: "Income Tax officer issuing a digital notice while the ProHippo mascot follows its journey." },
  { img: f02, variant: "fp-b", tag: "Inbox monitored",
    title: "Email misses it. ProHippo does not.",
    body: "Even when the assessee leaves the email unopened, the deadline never disappears from view.",
    alt: "ProHippo mascot finding an unopened notice inside a crowded email inbox." },
  { img: f03, variant: "fp-c", tag: "User alerted",
    title: "The right alert reaches WhatsApp.",
    body: "The user gets the matter, assessment year and due date where attention already lives.",
    alt: "Tax notice travelling into a phone alert beside the ProHippo mascot." },
  { img: f04, variant: "fp-d", tag: "Calendar synced",
    title: "The hearing books itself.",
    body: "ProHippo reads the notice and places the hearing in the calendar with the matter attached.",
    alt: "ProHippo mascot adding a tax hearing document to a calendar automatically." },
  { img: f05, variant: "fp-a", tag: "Hearing ready",
    title: "The reminder arrives on time.",
    body: "On the hearing date, a clear mobile notification brings the right file back to the top.",
    alt: "Mobile hearing reminder connected to the prepared ProHippo mascot." },
  { img: f06, variant: "fp-c", tag: "Reply submitted",
    title: "Type. Review. Submit.",
    body: "Prepare the reply in one focused workspace, then move it forward without losing the matter thread.",
    alt: "ProHippo mascot typing a reply and pressing a glowing submit control." },
  { img: f07, variant: "fp-b", tag: "Appeal window open",
    title: "The order starts a live countdown.",
    body: "When the order arrives, ProHippo turns the appeal window into a deadline nobody can ignore.",
    alt: "ProHippo mascot reading an order beside a live appeal countdown." },
  { img: f08, variant: "fp-d", tag: "Portal confirmed",
    title: "The appeal closes the loop.",
    body: "File the appeal and see the Income Tax portal acknowledgement inside the same connected matter.",
    alt: "ProHippo mascot filing an appeal and receiving portal confirmation." },
];

const PROOF = [
  { k: "Always visible", v: "No notice gets buried." },
  { k: "Always moving", v: "No handoff loses context." },
  { k: "Always on time", v: "No deadline becomes a surprise." },
];

/* Ports the design's GSAP timeline: hero intro, the pinned horizontal
   journey scrub, and the section reveals. Honours reduced-motion. */
function useJourneyMotion(rootRef) {
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = gsap.context(() => {
      gsap.from(".lp-nav", { y: -24, opacity: 0, duration: 0.8, ease: "power3.out" });
      gsap.from(".lp-hero-title", { y: 22, opacity: 0, duration: 0.8, ease: "power4.out", delay: 0.1 });
      gsap.from([".lp-hero-logo", ".lp-hero-sub", ".lp-hero-cta"], { y: 18, opacity: 0, duration: 0.7, stagger: 0.07, ease: "power3.out", delay: 0.4 });
      gsap.from(".lp-hero-visual img", { y: 26, opacity: 0, scale: 0.96, transformOrigin: "center bottom", duration: 0.9, ease: "power3.out", delay: 0.25 });

      const track = root.querySelector(".lp-track");
      const shell = root.querySelector(".lp-journey");

      if (track && shell && window.matchMedia("(min-width: 901px)").matches) {
        const distance = () => Math.max(0, track.scrollWidth - window.innerWidth);
        const journeyTween = gsap.to(track, {
          x: () => -distance(),
          ease: "none",
          scrollTrigger: { trigger: shell, start: "top top", end: () => "+=" + distance(), pin: true, scrub: 0.75, invalidateOnRefresh: true, anticipatePin: 1 },
        });
        gsap.fromTo(".lp-progress span", { scaleX: 0 }, {
          scaleX: 1, ease: "none",
          scrollTrigger: { trigger: shell, start: "top top", end: () => "+=" + distance(), scrub: true },
        });
        root.querySelectorAll(".lp-art img").forEach((image) => {
          gsap.fromTo(image, { xPercent: 3 }, {
            xPercent: -3, ease: "none",
            scrollTrigger: { trigger: image.closest(".lp-panel"), containerAnimation: journeyTween, start: "left right", end: "right left", scrub: true },
          });
        });
        root.querySelectorAll(".lp-panel").forEach((panel) => {
          const copy = panel.querySelector(".lp-copy");
          if (!copy) return;
          gsap.fromTo(copy, { x: 42, opacity: 0.35 }, {
            x: 0, opacity: 1, ease: "none",
            scrollTrigger: { trigger: panel, containerAnimation: journeyTween, start: "left 82%", end: "left 48%", scrub: true },
          });
        });
      } else if (track) {
        root.querySelectorAll(".lp-panel").forEach((panel) => {
          gsap.from(panel, { y: 48, opacity: 0, duration: 0.8, ease: "power3.out", scrollTrigger: { trigger: panel, start: "top 82%", once: true } });
        });
      }

      gsap.from(".lp-manifesto-line", { yPercent: 105, duration: 0.9, stagger: 0.08, ease: "power4.out", scrollTrigger: { trigger: ".lp-manifesto", start: "top 70%", once: true } });
      gsap.from(".lp-closing-card", { clipPath: "inset(16% 10% 16% 10% round 16px)", scale: 0.94, duration: 1, ease: "power3.out", scrollTrigger: { trigger: ".lp-closing", start: "top 70%", once: true } });
      gsap.from(".lp-proof-row", { x: 30, opacity: 0, duration: 0.7, stagger: 0.12, ease: "power3.out", scrollTrigger: { trigger: ".lp-proof", start: "top 78%", once: true } });
      gsap.from(".lp-closing-card img", { yPercent: 18, rotate: 3, opacity: 0, duration: 1, ease: "power3.out", scrollTrigger: { trigger: ".lp-closing", start: "top 68%", once: true } });
    }, root);

    return () => ctx.revert();
  }, [rootRef]);
}

/* Drives the hero headline cascade: plays once on mount (so touch
   devices see it), then follows hover. Honours reduced-motion. */
function useHeadlineReveal(totalChars, { stagger = 25, duration = 260, delay = 650 } = {}) {
  const [hovered, setHovered] = React.useState(false);
  const [auto, setAuto] = React.useState(false);
  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const runFor = totalChars * stagger + duration + 260;
    const on = setTimeout(() => setAuto(true), delay);
    const off = setTimeout(() => setAuto(false), delay + runFor);
    return () => { clearTimeout(on); clearTimeout(off); };
  }, [totalChars, stagger, duration, delay]);
  return {
    revealed: hovered || auto,
    bind: { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) },
  };
}

/* Hero headline. Split per word (so lines still wrap on narrow screens)
   while the cascade stagger runs continuously across the whole phrase;
   "again." keeps the brand accent. Stagger start indices are precomputed
   here so the render stays free of mutation. */
const HERO_SEGMENTS = (() => {
  const raw = [
    { w: "Never", line: 1 }, { w: "miss", line: 1 }, { w: "an", line: 1 }, { w: "income", line: 1 },
    { w: "tax", line: 2 }, { w: "notice", line: 2 }, { w: "again.", line: 2, accent: true },
  ];
  let start = 0;
  return raw.map((seg) => {
    const withStart = { ...seg, start };
    start += seg.w.length + 1; // +1 keeps the stagger flowing across the space
    return withStart;
  });
})();
const HERO_TITLE_CHARS = HERO_SEGMENTS.reduce((n, s) => n + s.w.length + 1, 0);
const ACCENT_PROPS = { color: "#6d55e7", hoverColor: "#9a80ff", className: "lp-accent" };

function HeroHeadline({ revealed, bind }) {
  const renderLine = (lineNo) =>
    HERO_SEGMENTS.filter((s) => s.line === lineNo).map((s, i) => (
      <React.Fragment key={s.start}>
        {i > 0 ? " " : null}
        <CascadeText text={s.w} hovered={revealed} startIndex={s.start} {...(s.accent ? ACCENT_PROPS : {})} />
      </React.Fragment>
    ));
  return (
    <h1 className="lp-hero-title" aria-label="Never miss an income tax notice again." {...bind}>
      <span className="lp-line" aria-hidden="true">{renderLine(1)}</span>
      <span className="lp-line" aria-hidden="true">{renderLine(2)}</span>
    </h1>
  );
}

export default function Landing({ onSignIn }) {
  const rootRef = React.useRef(null);
  useJourneyMotion(rootRef);
  const { revealed, bind } = useHeadlineReveal(HERO_TITLE_CHARS);

  const year = new Date().getFullYear();
  const scrollTo = (id) => (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <main className="landing-site" ref={rootRef}>
      {/* Nav */}
      <header className="lp-nav">
        <button className="lp-brand" onClick={scrollTo("lp-top")} aria-label="ProHippo — back to top">
          <span className="lp-dot">H</span>
          <span>ProHippo</span>
        </button>
        <nav className="lp-nav-links">
          <a className="lp-nav-link" href="#lp-journey" onClick={scrollTo("lp-journey")}>How it works</a>
          <button className="lp-nav-link hide-xs" onClick={onSignIn}>Sign in</button>
          <button className="lp-nav-cta" onClick={onSignIn}>Get ProHippo</button>
        </nav>
      </header>

      {/* Hero */}
      <section className="lp-hero" id="lp-top">
        <div className="lp-hero-copy">
          <img className="lp-hero-logo" src={logo} alt="ProHippo" />
          <HeroHeadline revealed={revealed} bind={bind} />
          <p className="lp-hero-sub">From notice to appeal, ProHippo watches everything.</p>
          <button className="lp-btn lp-btn-primary lp-hero-cta" onClick={onSignIn}>Get ProHippo</button>
        </div>
        <figure className="lp-hero-visual">
          <img src={heroScene} alt="ProHippo beside a mobile tax notice alert and an Income Tax notice envelope." />
        </figure>
      </section>

      {/* Manifesto */}
      <section className="lp-manifesto">
        <p className="lp-manifesto-kicker">One matter. One unbroken journey.</p>
        <h2 className="lp-manifesto-title">
          <span className="lp-line"><span className="lp-manifesto-line">Never unseen.</span></span>
          <span className="lp-line"><span className="lp-manifesto-line accent">Never too late.</span></span>
        </h2>
      </section>

      {/* Journey */}
      <section className="lp-journey" id="lp-journey">
        <div className="lp-journey-head">
          <span>Notice</span>
          <div className="lp-progress" aria-hidden="true"><span /></div>
          <span>Appeal</span>
        </div>
        <div className="lp-track">
          {JOURNEY.map((p, i) => (
            <article className={`lp-panel ${p.variant}`} key={i}>
              <div className="lp-copy">
                <h2>{p.title}</h2>
                <p>{p.body}</p>
                <span className="lp-tag"><i aria-hidden="true" />{p.tag}</span>
              </div>
              <figure className="lp-art">
                <img src={p.img} alt={p.alt} loading={i > 0 ? "lazy" : "eager"} />
              </figure>
            </article>
          ))}
        </div>
      </section>

      {/* Control */}
      <section className="lp-control">
        <div>
          <h2>Deadline anxiety has a new ending.</h2>
          <p className="lp-control-sub">Every alert, hearing, reply, order and appeal stays connected to the matter that created it.</p>
        </div>
        <div className="lp-proof">
          {PROOF.map((row) => (
            <div className="lp-proof-row" key={row.k}>
              <strong>{row.k}</strong>
              <span>{row.v}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Closing */}
      <section className="lp-closing" id="lp-contact">
        <div className="lp-closing-card">
          <div className="lp-closing-inner">
            <p className="lp-closing-kicker">Ready when the notice arrives.</p>
            <h2>Put every tax matter under control.</h2>
          </div>
          <button className="lp-btn lp-btn-ink" onClick={onSignIn}>Get ProHippo</button>
          <img className="lp-mascot" src={mascot} alt="ProHippo mascot ready to manage the next tax matter." />
        </div>
      </section>

      {/* Footer */}
      <footer className="lp-footer">
        <div>
          <a className="lp-brand" href="#lp-top" onClick={scrollTo("lp-top")}>
            <span className="lp-dot">H</span>
            <span>ProHippo</span>
          </a>
          <p className="lp-foot-tag">Tax matter management for people who cannot afford to miss what matters.</p>
        </div>
        <nav className="lp-foot-links" aria-label="Legal and company">
          <a href="/about">About</a>
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms &amp; Conditions</a>
          <a href="/contact">Contact</a>
          <a href="/data-deletion">Data Deletion</a>
        </nav>
        <span className="lp-foot-meta">© {year} ProHippo</span>
        <div className="lp-foot-legal">
          ProHippo is a product operated by MEHTAJI BIZCON LLP (LLPIN AAV-0638), Ahmedabad, India.
        </div>
      </footer>
    </main>
  );
}
