// Firebase web config — Firebase console → Project settings → General → Your apps → Web app → "Config".
// These values are safe to publish: access is enforced by firestore.rules, not by hiding this file.
export const firebaseConfig = {
  apiKey: 'AIzaSyCJ9VoTYzvUcTdhmcLab4W2fTC3rATioZ0',
  authDomain: 'limntracker.firebaseapp.com',
  projectId: 'limntracker',
  storageBucket: 'limntracker.firebasestorage.app',
  messagingSenderId: '963386664952',
  appId: '1:963386664952:web:fce7e627e8bc487db9980d'
};

// Firestore collection your pipeline writes businesses into.
export const BUSINESSES_COLLECTION = 'businesses';

// Usernames are turned into Firebase Auth emails behind the scenes (no email is ever sent).
export const USERNAME_EMAIL_DOMAIN = 'users.limn-leads.app';
