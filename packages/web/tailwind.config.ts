import type { Config } from "tailwindcss";

const v = (name: string) => `var(--${name})`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        "surface-1": v("surface-1"),
        "surface-2": v("surface-2"),
        "surface-3": v("surface-3"),
        border: v("border"),
        "border-strong": v("border-strong"),
        fg: v("fg"),
        "fg-muted": v("fg-muted"),
        "fg-faint": v("fg-faint"),
        state: {
          starting: v("state-starting"),
          working: v("state-working"),
          waiting: v("state-waiting"),
          idle: v("state-idle"),
          error: v("state-error"),
          ended: v("state-ended"),
          exited: v("state-exited"),
        },
        meter: {
          ok: v("meter-ok"),
          warn: v("meter-warn"),
          high: v("meter-high"),
          track: v("meter-track"),
        },
        accent: { DEFAULT: v("accent"), attention: v("accent-attention") },
      },
      fontFamily: { ui: v("font-ui"), mono: v("font-mono") },
      fontSize: {
        xs: v("text-xs"),
        sm: v("text-sm"),
        md: v("text-md"),
        lg: v("text-lg"),
        xl: v("text-xl"),
      },
      spacing: {
        "s-1": v("s-1"),
        "s-2": v("s-2"),
        "s-3": v("s-3"),
        "s-4": v("s-4"),
        "s-6": v("s-6"),
        "s-8": v("s-8"),
      },
      borderRadius: { DEFAULT: v("radius"), lg: v("radius-lg") },
      transitionDuration: { fast: v("t-fast"), base: v("t-base") },
      transitionTimingFunction: { DEFAULT: v("ease") },
    },
  },
} satisfies Config;
