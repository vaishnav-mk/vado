import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

export const THEME_KEY = "vado-docs-theme";

// Runs in <head> before the first paint, so a stored or system dark theme never flashes light.
export const THEME_SCRIPT = `(()=>{let d=matchMedia("(prefers-color-scheme: dark)").matches;try{const s=localStorage.getItem("${THEME_KEY}");if(s)d=s==="dark"}catch{}document.documentElement.dataset.theme=d?"dark":"light"})()`;

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => setDark(document.documentElement.dataset.theme === "dark"), []);

  const toggle = () => {
    const next = dark ? "light" : "dark";

    setDark(!dark);
    document.documentElement.dataset.theme = next;

    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private browsing can refuse storage; the theme still applies to this page.
    }
  };

  return (
    <button
      type="button"
      className="rounded-md p-2 text-soft hover:bg-wash"
      aria-label={dark ? "Use light theme" : "Use dark theme"}
      onClick={toggle}
    >
      {dark ? <SunIcon size={15} /> : <MoonIcon size={15} />}
    </button>
  );
}
