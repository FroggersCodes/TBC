// Firebase Configuration
// Replace these values with your Firebase project settings
// Get them from: https://console.firebase.google.com > Project Settings > General > Your apps
const firebaseConfig = {
    apiKey: "AIzaSyDD8pg2EzgRSzN9bcx-iMmHsFG2BOMW8PU",
    authDomain: "note-484b0.firebaseapp.com",
    projectId: "note-484b0",
    storageBucket: "note-484b0.firebasestorage.app",
    messagingSenderId: "226022818324",
    appId: "1:226022818324:web:428fa3f0d51f57acf21d01"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// Enable offline persistence
db.enablePersistence().catch(function (err) {
    if (err.code === 'failed-precondition') {
        console.warn('Firestore persistence unavailable: multiple tabs open');
    } else if (err.code === 'unimplemented') {
        console.warn('Firestore persistence not supported in this browser');
    }
});
