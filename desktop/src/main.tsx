import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
import "misans/lib/Normal/MiSansVF.min.css";
import { App } from "./App";
import "./styles/globals.css";
// Legacy 0.3.5 stylesheet kept temporarily until Wave 2 replaces the views.
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
