import React from "react";
import ReactDOM from "react-dom/client";
import { MainWindow } from "./app/MainWindow";
import { installWindowBehaviour } from "./lib/native";
import { demoEnabled, installUiZoom, openNativePlayer } from "./lib/nimbus";
import { VideoOverlay } from "./player/VideoOverlay";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/controls.css";
import "./styles/shell.css";
import "./styles/views.css";
import "./styles/player.css";
import "./styles/video.css";

// The same bundle serves the library window, the transparent video controls window and (on
// Windows) the PDF reader windows.
const query = new URLSearchParams(window.location.search);
const videoWindow = query.has("player-controls");
const readerWindow = query.has("reader");
if (videoWindow) document.documentElement.classList.add("video-window");
if (readerWindow) document.documentElement.classList.add("reader-window");
installWindowBehaviour({ vibrancy: !videoWindow && !readerWindow });
// A reader zooms its pages, not the interface.
if (!readerWindow) installUiZoom();

// Browser layout fixture for the video controls: `?player-controls&demo=1&fixture=video`.
if (videoWindow && demoEnabled && new URLSearchParams(window.location.search).get("fixture") === "video") {
  document.documentElement.style.background = "#3a3f47";
  void openNativePlayer("movie-10");
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
if (readerWindow) {
  // pdf.js loads only in reader windows.
  void import("./reader/Reader").then(({ Reader }) =>
    root.render(
      <React.StrictMode>
        <Reader />
      </React.StrictMode>,
    ),
  );
} else {
  root.render(<React.StrictMode>{videoWindow ? <VideoOverlay /> : <MainWindow />}</React.StrictMode>);
}
