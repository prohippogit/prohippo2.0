/*
 * firebase/functions stand-in for the screenshot harness. See ./firestore.js.
 * Every callable rejects: the harness photographs screens, it does not drive
 * flows, and a callable that silently "succeeded" would let a screen render a
 * state the real backend never produced.
 */
export const getFunctions = () => ({ __functions: true });
export const connectFunctionsEmulator = () => {};
export const httpsCallable = () => async () => {
  throw new Error("screenshot harness: no backend");
};
