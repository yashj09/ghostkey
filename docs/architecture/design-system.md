# Design system (web app)

Derived from the ui-ux-pro-max recommendations ("security / ops tool"), adapted to a **clean, minimal** brief that works on a **projector** and in both themes.

## Principles
1. **One number first.** Every screen leads with the dollar amount the old key still controls. Everything else supports it.
2. **Severity is never colour-only.** Each surface row carries an icon, a text label and a colour (WCAG `color-not-only`).
3. **Readable from the back row.** Live Demo numbers are at least 48px, and the body text is at least 16px. Tabular figures stop numbers jumping as they change.
4. **No third-party requests in the client.** Fonts are self-hosted (`@fontsource`), there's no analytics, and the only network calls go to the user's RPC (plus the opt-in Safe API). This is our own CROPS "P".

## Tokens
- **Base:** shadcn/ui `neutral` palette with CSS variables, light and dark (`class` strategy, with a toggle that respects the system default).
- **Accent:** a single violet (`--primary`, e.g. `oklch(0.55 0.2 290)` / dark `oklch(0.7 0.16 290)`), used for the one primary CTA per screen.
- **Status colours** (semantic tokens, contrast checked at 4.5:1 in both themes):

| Severity | Token | Icon (lucide) | Label |
|---|---|---|---|
| exposed | `--sev-exposed` (red) | `ShieldAlert` | Exposed |
| protocol-only | `--sev-protocol` (orange) | `Lock` (broken) / `KeyRound` | Protocol-level |
| conditional | `--sev-conditional` (amber) | `ShieldQuestion` | Conditional |
| clear | `--sev-clear` (green) | `ShieldCheck` | Clear |

## Typography
- **UI:** Geist 400 / 500 / 600 (self-hosted, shadcn nova preset). Display numbers use 700 with `tracking-tight` and `tabular-nums`.
- **Data** (addresses, hashes, amounts, event log): JetBrains Mono 400 / 500.
- **Scale:** 12 · 14 · 16 · 18 · 24 · 32 · 48 · 64.

## Layout
- `max-w-6xl` container, 8px spacing rhythm, a 12-column grid on desktop that stacks on mobile.
- **Scan:** a search bar (address or ENS, plus advanced hints) → headline card (USD controlled by the old key, conditional USD) → surface table (severity, surface, assets, USD, fixable) → "Build migration" panel.
- **Live Demo:** a left vertical stepper (8 steps) → centre stage (a big number plus the current step's explanation) → right event log (monospace, newest first). The bottom bar holds the single primary action ("Next step") and **Reset**.

## Components (shadcn/ui)
`button`, `card`, `badge`, `table`, `input`, `tabs`, `separator`, `tooltip`, `sonner` (toasts), `skeleton`, `scroll-area`, `progress`, `switch`, `dialog`. Icons come from `lucide-react` only, never emoji.

## Motion
150–250ms ease-out. Changing numbers animate with a short count. `prefers-reduced-motion` disables count-ups and slides. At most 1–2 animated elements per view.
