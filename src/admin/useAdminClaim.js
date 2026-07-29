/*
 * Is the signed-in user an admin?
 *
 * The answer lives in the ID token as a custom claim, so this is a local check
 * — no Firestore round-trip. `getIdTokenResult(true)` forces a refresh, which
 * matters right after a claim is granted: a token already in the browser keeps
 * its old claims for up to an hour otherwise.
 *
 * This gate only decides what to RENDER. Every read the console makes is
 * separately gated by firestore.rules, and every write by requireAdmin() in the
 * callables — so a user who patches this hook in devtools gets an empty screen
 * and a wall of permission-denied, not access.
 */
import React from "react";
import { useAuth } from "../auth";

/*
 * `force` refreshes the ID token before reading it. The console needs that —
 * a claim granted a minute ago must not be invisible for the next hour. The
 * practitioner's sidebar does not: it only decides whether to show a link, and
 * making every user on every page load pay for a token refresh to answer a
 * question that is "no" for almost all of them is a poor trade.
 */
export function useAdminClaim({ force = true } = {}) {
  const { user } = useAuth();
  // null = not looked up yet for this user.
  const [claim, setClaim] = React.useState(null);

  React.useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    user
      .getIdTokenResult(force)
      .then((res) => { if (!cancelled) setClaim(res.claims?.admin === true); })
      .catch(() => { if (!cancelled) setClaim(false); });
    // Clearing on teardown means a second account signing in never inherits
    // the first one's verdict for a frame.
    return () => { cancelled = true; setClaim(null); };
  }, [user, force]);

  return { checking: !!user && claim === null, isAdmin: claim === true };
}
