// Layout fixture for the music player: loads the app with demo data and starts a song
// with long synthetic lyrics, so artwork, lyrics and the queue can be checked in a browser.
const params = new URLSearchParams({ demo: "1", fixture: "music" });
history.replaceState(null, "", `/?${params}`);
await import("../src/main");
