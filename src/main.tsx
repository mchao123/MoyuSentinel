import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./NativeApp";
import { Overlay } from "./Overlay";
import { Popup } from "./Popup";
import "./style.css";

const overlay = new URLSearchParams(location.search).has("overlay");
const popup = new URLSearchParams(location.search).has("popup");
document.documentElement.classList.toggle("overlay-page", overlay);
document.documentElement.classList.toggle("popup-page", popup);
createRoot(document.getElementById("root")!).render(
  overlay ? <Overlay /> : popup ? <Popup /> : <App />,
);
