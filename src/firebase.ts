import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, doc, getDoc, query, where, orderBy } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDpiXGHG1zxDYupSzf1zlZCDUMXaHiDyGs",
  authDomain: "betax-696d9.firebaseapp.com",
  projectId: "betax-696d9",
  storageBucket: "betax-696d9.firebasestorage.app",
  messagingSenderId: "579150601654",
  appId: "1:579150601654:web:86a38d390436fb35747517"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
