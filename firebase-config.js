// Your Firebase config. The app reads this as an ES module.
// IMPORTANT: do not add npm-style `import` lines here — they break the browser.
// The auction app initializes Firebase itself; you only export the config object.
//
// `databaseURL` is REQUIRED. After you create the Realtime Database in the
// Firebase console it will appear at the top of the data tab and look like:
//   https://fifa-auction-6f91c-default-rtdb.firebaseio.com
//   OR
//   https://fifa-auction-6f91c-default-rtdb.europe-west1.firebasedatabase.app
// Paste whichever exact URL Firebase shows you below.

export const firebaseConfig = {
  apiKey: "AIzaSyD37TU8c-L_R6Cqp20tgK9uhsKRlxHyn-A",
  authDomain: "fifa-auction-6f91c.firebaseapp.com",
  databaseURL: "https://fifa-auction-6f91c-default-rtdb.firebaseio.com/", // ← VERIFY this matches your Realtime Database URL
  projectId: "fifa-auction-6f91c",
  storageBucket: "fifa-auction-6f91c.firebasestorage.app",
  messagingSenderId: "710149341310",
  appId: "1:710149341310:web:286d306180e19a0d9e982f",
  measurementId: "G-DZ39046Y8N",
};
