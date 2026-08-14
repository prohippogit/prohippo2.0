// firebase/storage stand-in for the screenshot harness. See ./firestore.js.
export const getStorage = () => ({ __storage: true });
export const connectStorageEmulator = () => {};
export const ref = (storage, path) => ({ path });
export const getDownloadURL = async () => { throw new Error("screenshot harness: no storage"); };
export const uploadString = async () => ({});
export const uploadBytes = async () => ({});
