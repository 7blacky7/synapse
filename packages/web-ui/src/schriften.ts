/**
 * P22-T267 (Befund thought f5adb6ff, Entscheidung Koordinator 01.11.2026): Die Web-UI nennt im CSS ueberall "Syne" (Titel) und
 * "IBM Plex Mono" (Labels, Daten), hat sie aber nie ausgeliefert. Ohne lokal installierte Schrift sah der User Ersatzschriften.
 * Jetzt selbst gehostet ueber @fontsource (kein CDN): Vite legt die woff2-Dateien ins eigene Buendel, font-display: swap ist der
 * Fontsource-Standard (Text sofort sichtbar, Schrift tauscht nach dem Laden). Nur die Subsets latin und latin-ext (Umlaute, ß,
 * Sonderzeichen); per unicode-range laedt der Browser je Schnitt nur, was die Seite braucht.
 * Schnitte nach Bestand (thought f205db25): Syne 600/700/800, IBM Plex Mono 400/500/600/700 (800 im CSS faellt auf 700 zurueck).
 * Rueckweg: diese Datei samt Import in main.tsx und die beiden Pakete in package.json entfernen.
 */
import '@fontsource/syne/latin-600.css';
import '@fontsource/syne/latin-ext-600.css';
import '@fontsource/syne/latin-700.css';
import '@fontsource/syne/latin-ext-700.css';
import '@fontsource/syne/latin-800.css';
import '@fontsource/syne/latin-ext-800.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-ext-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-ext-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-ext-600.css';
import '@fontsource/ibm-plex-mono/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-ext-700.css';
