/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./index.tsx",
    "./App.tsx",
    "./components/**/*.{ts,tsx}",
    "./services/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Design tokens. CSS vars are OKLCH triplets in globals.css so
        // Tailwind's `<alpha-value>` placeholder works (bg-bg/50, etc.).
        bg: "oklch(var(--bg) / <alpha-value>)",
        "bg-2": "oklch(var(--bg-2) / <alpha-value>)",
        "bg-3": "oklch(var(--bg-3) / <alpha-value>)",
        surface: "oklch(var(--surface) / <alpha-value>)",
        "surface-2": "oklch(var(--surface-2) / <alpha-value>)",
        border: "oklch(var(--border) / <alpha-value>)",
        "border-soft": "oklch(var(--border-soft) / <alpha-value>)",
        fg: "oklch(var(--fg) / <alpha-value>)",
        "fg-2": "oklch(var(--fg-2) / <alpha-value>)",
        "fg-3": "oklch(var(--fg-3) / <alpha-value>)",
        accent: "oklch(var(--accent) / <alpha-value>)",
        "accent-soft": "oklch(var(--accent) / 0.14)",
        "accent-fg": "oklch(var(--accent-fg) / <alpha-value>)",
        danger: "oklch(var(--danger) / <alpha-value>)",
        "danger-soft": "oklch(var(--danger) / 0.16)",
        success: "oklch(var(--success) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Geist", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ['"Geist Mono"', "ui-monospace", '"SF Mono"', "Menlo", "monospace"],
      },
      borderRadius: {
        card: "14px",
        pill: "999px",
      },
      boxShadow: {
        soft:
          "0 1px 0 oklch(1 0 0 / 0.04) inset, 0 1px 2px oklch(0 0 0 / 0.3)",
        lifted:
          "0 1px 0 oklch(1 0 0 / 0.04) inset, 0 8px 24px oklch(0 0 0 / 0.35)",
        drawer:
          "0 1px 0 oklch(1 0 0 / 0.05) inset, 0 24px 60px oklch(0 0 0 / 0.55)",
      },
      screens: {
        xs: "475px",
      },
    },
  },
  plugins: [],
};
