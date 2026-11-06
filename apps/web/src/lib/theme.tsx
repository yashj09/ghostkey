import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** Light/dark toggle. index.html applies the stored/system theme before first paint. */
export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("gk-theme", dark ? "dark" : "light");
  }, [dark]);
  return (
    <Button variant="ghost" size="icon" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setDark((d) => !d)}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
