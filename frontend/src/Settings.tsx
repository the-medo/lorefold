import { Palette, Settings, UserRound } from "lucide-react";
import { ThemesSettings } from "./Themes.js";
import "./settings.css";

export function SettingsPage({ user, section, navigate }: {
  user: { name: string; email: string };
  section: "account" | "themes";
  navigate: (path: string) => void;
}) {
  return <main className="settings-page">
    <header className="settings-heading">
      <div><span className="eyebrow">MAKE YOURSELF AT HOME</span><h1>User settings</h1><p className="muted">Your account and the way your reading space feels.</p></div>
      <Settings size={30} strokeWidth={1.3} />
    </header>
    <nav className="settings-navigation" aria-label="Settings navigation">
      <button className={section === "account" ? "active" : ""} aria-current={section === "account" ? "page" : undefined} onClick={() => navigate("/settings")}><UserRound size={17} />Account</button>
      <button className={section === "themes" ? "active" : ""} aria-current={section === "themes" ? "page" : undefined} onClick={() => navigate("/settings/themes")}><Palette size={17} />Themes</button>
    </nav>
    {section === "themes" ? <ThemesSettings /> : <section className="settings-account" aria-labelledby="account-heading">
      <h2 id="account-heading">Your account</h2>
      <p className="muted">You’re signed in to your private Lorefold space.</p>
      <dl><div><dt>Name</dt><dd>{user.name}</dd></div><div><dt>Email address</dt><dd>{user.email}</dd></div></dl>
      <button className="secondary" onClick={() => navigate("/settings/themes")}><Palette size={17} />Customize your themes</button>
    </section>}
  </main>;
}
