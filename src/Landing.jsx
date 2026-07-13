/* ProHippo — public landing page (shown before sign-in) */
import React from "react";
import { Icon } from "./shared";
import heroImg from "./assets/hero.png";
import "./landing.css";

function BrandMark({ size = 36 }) {
  return (
    <div className="brand-mark" style={{ width: size, height: size, background: "linear-gradient(135deg, #6C5CE7, #C13388)" }}>
      <svg viewBox="0 0 24 24" width={size * 0.6} height={size * 0.6} fill="none">
        <path d="M6 4c3 0 3 4 6 4s3-4 6-4v16c-3 0-3-4-6-4s-3 4-6 4V4z" fill="white" />
      </svg>
    </div>
  );
}

/* Adds .visible to .reveal children when they scroll into view */
function useReveal() {
  React.useEffect(() => {
    const els = document.querySelectorAll(".landing .reveal");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

const FEATURES = [
  {
    icon: "sparkle", tint: "var(--p-lavender-2)", color: "var(--p-primary-2)",
    title: "AI notice parser",
    desc: "Upload a scrutiny or demand notice and let AI extract the section, assessment year, deadlines and demand — ready to file in seconds.",
  },
  {
    icon: "doc", tint: "var(--p-pink)", color: "#C13388",
    title: "Notices & replies",
    desc: "Every notice tracked from receipt to submission, with drafts, statuses and due dates that never slip through the cracks.",
  },
  {
    icon: "calendar", tint: "var(--p-amber)", color: "#B07512",
    title: "Hearings & deadlines",
    desc: "A single calendar for hearings, adjournments and statutory due dates — urgent items surface before they become emergencies.",
  },
  {
    icon: "users", tint: "var(--p-mint)", color: "#1B8C5C",
    title: "Assessee directory",
    desc: "All your clients with PANs, contacts and complete matter history in one searchable place.",
  },
  {
    icon: "scale", tint: "var(--p-lavender-2)", color: "var(--p-primary-2)",
    title: "Matters & litigation",
    desc: "Follow each appeal across CIT(A), ITAT and beyond — grounds, demands and outcomes organised by assessee.",
  },
  {
    icon: "invoice", tint: "var(--p-coral)", color: "#B8463A",
    title: "Invoices & reports",
    desc: "Raise invoices, watch outstanding fees, and see how your practice is really doing with built-in reports.",
  },
];

const STEPS = [
  {
    title: "Bring in a notice",
    desc: "Drop in the PDF you received from the department. The AI parser reads it and fills in the details for you.",
  },
  {
    title: "Review & organise",
    desc: "Confirm the extracted details, link the notice to an assessee and matter, and set the response deadline.",
  },
  {
    title: "Track to closure",
    desc: "Draft the reply, log hearings and communications, invoice the work — everything stays connected until the matter closes.",
  },
];

const BAND_POINTS = [
  "Built specifically for Indian income-tax practice",
  "Your data is private to your account, stored securely in the cloud",
  "Sign in with Google or a one-time email link — no passwords",
  "Works wherever you are, on any modern browser",
];

export default function Landing({ onSignIn }) {
  useReveal();

  return (
    <div className="landing">
      <div className="landing-blob b1" />
      <div className="landing-blob b2" />
      <div className="landing-blob b3" />

      <div className="landing-inner">
        {/* Nav */}
        <nav className="landing-nav hero-in d1">
          <BrandMark />
          <div className="brand-name" style={{ fontSize: 19 }}>
            Pro<span style={{ color: "var(--p-primary-2)" }}>Hippo</span>
          </div>
          <div className="spacer" />
          <a className="landing-nav-link" href="#features">Features</a>
          <a className="landing-nav-link" href="#how">How it works</a>
          <button className="btn btn-primary btn-sm" onClick={onSignIn}>Sign in</button>
        </nav>

        {/* Hero */}
        <header className="landing-hero">
          <div>
            <div className="hero-eyebrow hero-in d1">
              <span className="pill-dot" /> Built for income-tax professionals
            </div>
            <h1 className="hero-title hero-in d2">
              Your entire tax practice,<br />
              <span className="accent">in one calm place.</span>
            </h1>
            <p className="hero-sub hero-in d3">
              ProHippo keeps notices, hearings, assessees, matters and invoices organised —
              with an AI parser that reads department notices for you, so nothing is missed
              and no deadline slips.
            </p>
            <div className="hero-ctas hero-in d4">
              <button className="btn btn-primary btn-lg" onClick={onSignIn}>
                Get started <Icon name="arrow-right" size={16} />
              </button>
              <a className="btn btn-secondary btn-lg" href="#features" style={{ textDecoration: "none" }}>
                Explore features
              </a>
            </div>
            <div className="hero-note hero-in d4">
              Free to start · Sign in with Google or a secure email link
            </div>
          </div>

          <div className="hero-visual hero-in d5">
            <img src={heroImg} alt="" aria-hidden="true" />
            <div className="hero-chip c1">
              <div className="chip-icon" style={{ background: "var(--p-lavender-2)", color: "var(--p-primary-2)" }}>
                <Icon name="sparkle" size={15} />
              </div>
              <div>
                Notice parsed
                <span className="chip-sub">u/s 143(2) · AY 2024-25</span>
              </div>
            </div>
            <div className="hero-chip c2">
              <div className="chip-icon" style={{ background: "var(--p-amber)", color: "#B07512" }}>
                <Icon name="clock" size={15} />
              </div>
              <div>
                Reply due in 6 days
                <span className="chip-sub">Reminder set</span>
              </div>
            </div>
          </div>
        </header>

        {/* Features */}
        <section id="features" className="landing-section">
          <div className="reveal">
            <div className="section-label">Features</div>
            <h2 className="section-title">Everything a tax practice runs on</h2>
            <p className="section-sub">
              One workspace instead of spreadsheets, folders and sticky notes — designed
              around the way income-tax work actually flows.
            </p>
          </div>
          <div className="feature-grid">
            {FEATURES.map((f, i) => (
              <div key={f.title} className="feature-card reveal" style={{ "--reveal-delay": `${(i % 3) * 0.08}s` }}>
                <div className="feature-icon" style={{ background: f.tint, color: f.color }}>
                  <Icon name={f.icon} size={20} />
                </div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="landing-section">
          <div className="reveal">
            <div className="section-label">How it works</div>
            <h2 className="section-title">From notice to closure in three steps</h2>
          </div>
          <div className="steps">
            {STEPS.map((s, i) => (
              <div key={s.title} className="step-card reveal" style={{ "--reveal-delay": `${i * 0.1}s` }}>
                <div className="step-num">{i + 1}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Highlight band */}
        <section className="landing-section">
          <div className="highlight-band reveal">
            <div>
              <h2>Calm software for a demanding profession</h2>
              <p className="band-sub">
                Deadlines, departments and demands are stressful enough. Your practice
                management shouldn't be.
              </p>
            </div>
            <div className="band-list">
              {BAND_POINTS.map((p) => (
                <div key={p} className="band-item">
                  <span className="band-check"><Icon name="check" size={13} stroke={2.6} /></span>
                  {p}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="landing-cta reveal">
          <BrandMark size={52} />
          <h2>Ready to tidy up your practice?</h2>
          <p>Sign in and set up your firm in under a minute. Your data stays private to your account.</p>
          <button className="btn btn-primary btn-lg" onClick={onSignIn}>
            Get started with ProHippo <Icon name="arrow-right" size={16} />
          </button>
        </section>

        {/* Footer */}
        <footer className="landing-footer">
          <div className="foot-brand">
            <BrandMark size={26} />
            <span>Pro<span style={{ color: "var(--p-primary-2)" }}>Hippo</span></span>
          </div>
          <div className="spacer" />
          <span>Income-tax litigation & practice management</span>
          <span>·</span>
          <span>© {new Date().getFullYear()} ProHippo</span>
        </footer>
      </div>
    </div>
  );
}
