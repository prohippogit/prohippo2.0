// firebase/app stand-in for the screenshot harness. See ./firestore.js.
export const initializeApp = () => ({ __app: true });
export const getApp = () => ({ __app: true });
