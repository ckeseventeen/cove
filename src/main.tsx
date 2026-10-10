import React from "react";
import ReactDOM from "react-dom/client";
import { MainWindow } from "./app/MainWindow";
import { installWindowBehaviour } from "./lib/native";
import { VideoOverlay } from "./player/VideoOverlay";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/controls.css";
import "./styles/shell.css";
import "./styles/views.css";
import "./styles/player.css";
import "./styles/video.css";

// The same bundle serves the library window and the transparent video controls window.
const videoWindow = new URLSearchParams(window.location.search).has("player-controls");
if (videoWindow) document.documentElement.classList.add("video-window");
installWindowBehaviour({ vibrancy: !videoWindow });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{videoWindow ? <VideoOverlay /> : <MainWindow />}</React.StrictMode>,
);
