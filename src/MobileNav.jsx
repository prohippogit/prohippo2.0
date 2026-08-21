/* ProHippo — the phone's own chrome: an app bar at the top, a tab bar at the
 * foot. Both are mobile-only; above 920px they are display:none and the desk
 * layout is exactly what it was.
 *
 * WHY A TAB BAR AT ALL. Every destination in this app used to sit behind one
 * floating hamburger in the bottom-right corner: to go from a hearing to the
 * assessee it belongs to was tap, wait for the drawer, read ten labels, tap.
 * On a phone the four or five places a practitioner actually moves between
 * belong on the screen at all times, one thumb-reach away, saying which one
 * they are on. That is what a tab bar is for, and it is why every phone app
 * that is used rather than admired has one.
 *
 * WHAT IS ON IT. The first four links of the sidebar, in the sidebar's own
 * order — the practice's registers — and then the drawer itself as "More".
 * Not a second navigation with its own opinion: the same list, with the
 * frequently-walked part lifted out of it.
 *
 * The badges are the sidebar's badges. A number that means one thing in the
 * drawer and another on the bar would be worse than no number.
 */
import React from 'react';
import { Icon } from './shared';
import { useData } from './store';
import { appealableOrders } from './appeals';
import { noticesAwaitingReply, countPastDue } from './noticeQueues';

// Four registers plus the drawer. "More" is not a page — it opens the same
// sidebar the hamburger opens, which is where everything else already lives.
const TABS = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "assessees", label: "Assessees", icon: "users" },
  { id: "matters", label: "Matters", icon: "scale" },
  { id: "hearings", label: "Hearings", icon: "calendar" },
  { id: "__more", label: "More", icon: "menu" },
];

// A route reached from the drawer still belongs to a tab where one owns it —
// an assessee's profile is opened from Assessees, and the bar should say so.
// Everything the bar does not carry is reached through the drawer, so while
// one of those pages is open the drawer's own tab is the one lit.
const OWNED_BY = ["appeals", "invoices", "communications", "intimations", "reports", "tools", "connector", "settings"];

/* WHAT THE BELL COUNTS: things already past their date. A notice whose reply
   day has gone, and an appeal whose limitation has lapsed. Both are counted
   today by the dashboard, in the two panels the bell navigates to — the bell
   is a way of noticing them from another screen, never a third opinion about
   what is urgent. */
export function useOverdueCount() {
  const { data } = useData();
  return React.useMemo(() => {
    // 15 days: the same window the dashboard's "awaiting reply" panel uses.
    const notices = countPastDue(noticesAwaitingReply(data.notices || [], { days: 15 }));
    const appeals = appealableOrders(data).filter((a) => a.daysLeft != null && a.daysLeft < 0).length;
    return notices + appeals;
  }, [data]);
}

/* The bar: the brand, and the bell. No hamburger — the floating button in the
   corner opens the drawer, and two controls doing the same thing on one 390px
   bar is one too many. */
export function MobileAppBar({ onBell, overdue = 0 }) {
  return (
    <header className="mob-appbar">
      {/* The mark on its own, beside a wordmark set in the app's own type.
          The full logo is drawn for a white ground and goes to mud on this
          one, and a 34px-tall lockup on a 390px bar is unreadable anyway. */}
      <div className="mob-appbar-brand">
        <img src="/prohippo-mark.png" alt="" aria-hidden="true" className="mob-appbar-mark"/>
        <span className="mob-appbar-word">ProHippo</span>
      </div>

      <button type="button" className="mob-appbar-btn" aria-label={overdue ? `${overdue} items past their date` : "Nothing overdue"} onClick={onBell}>
        <Icon name="bell" size={19}/>
        {overdue > 0 && <span className="mob-dot">{overdue > 99 ? "99+" : overdue}</span>}
      </button>
    </header>
  );
}

/* Counted once by the shell and handed down, rather than worked out again
   here: `overdue` walks every order in the practice, and `itatCount` is a live
   Firestore subscription the sidebar already holds open. Two components asking
   for the same number should not cost two of either. */
export function MobileTabBar({ active, onNav, onMore, menuOpen, overdue = 0, itatCount = 0 }) {
  const { data } = useData();
  const badges = {
    assessees: data.assessees.length || null,
    hearings: itatCount || null,
    // The drawer holds Appeals, and an appeal that has lapsed is the sharpest
    // thing in it. The bar carries that count so it is not silent behind a
    // word that says only "More".
    __more: overdue || null,
  };
  // Whichever tab owns the page being shown; "More" while the drawer is open.
  const current = menuOpen ? "__more"
    : TABS.some((t) => t.id === active) ? active
      : OWNED_BY.includes(active) ? "__more" : "";

  return (
    <nav className="mob-tabbar" aria-label="Primary">
      {TABS.map((t) => {
        const on = current === t.id;
        return (
          <button
            key={t.id}
            type="button"
            className={`mob-tab ${on ? "active" : ""}`}
            aria-current={on ? "page" : undefined}
            onClick={() => (t.id === "__more" ? onMore() : onNav(t.id))}
          >
            <span className="mob-tab-ico">
              <Icon name={t.icon} size={20}/>
              {badges[t.id] && <span className="mob-tab-dot">{badges[t.id] > 99 ? "99+" : badges[t.id]}</span>}
            </span>
            <span className="mob-tab-label">{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
