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
        vault: {
          900: "#0f172a",
          800: "#1e293b",
          700: "#334155",
          600: "#475569",
          accent: "#3b82f6",
        },
      },
      screens: {
        xs: "475px",
      },
    },
  },
  plugins: [],
};
