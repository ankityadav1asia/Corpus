import typography from '@tailwindcss/typography'
import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

const config = {
  darkMode: ['class'],
  content: ['./pages/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  prefix: '',
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      fontFamily: {
        sans: ['var(--font-body)'],
        display: ['var(--font-display)'],
        mono: ['var(--font-outlier)'],
      },
      // shadcn names point at the Console roles (app/tokens.css); the Console names are for new code.
      colors: {
        border: 'oklch(var(--lch-rule) / <alpha-value>)',
        input: 'oklch(var(--lch-field-edge) / <alpha-value>)',
        ring: 'oklch(var(--lch-accent) / <alpha-value>)',
        background: 'oklch(var(--lch-paper) / <alpha-value>)',
        foreground: 'oklch(var(--lch-ink) / <alpha-value>)',
        primary: { DEFAULT: 'oklch(var(--lch-accent) / <alpha-value>)', foreground: 'oklch(var(--lch-accent-ink) / <alpha-value>)' },
        secondary: { DEFAULT: 'oklch(var(--lch-paper-3) / <alpha-value>)', foreground: 'oklch(var(--lch-ink-2) / <alpha-value>)' },
        destructive: { DEFAULT: 'oklch(var(--lch-bad) / <alpha-value>)', foreground: 'oklch(var(--lch-bad-ink) / <alpha-value>)' },
        muted: { DEFAULT: 'oklch(var(--lch-paper-2) / <alpha-value>)', foreground: 'oklch(var(--lch-muted) / <alpha-value>)' },
        accent: { DEFAULT: 'oklch(var(--lch-paper-3) / <alpha-value>)', foreground: 'oklch(var(--lch-ink) / <alpha-value>)' },
        popover: { DEFAULT: 'oklch(var(--lch-paper-2) / <alpha-value>)', foreground: 'oklch(var(--lch-ink) / <alpha-value>)' },
        card: { DEFAULT: 'oklch(var(--lch-paper-2) / <alpha-value>)', foreground: 'oklch(var(--lch-ink) / <alpha-value>)' },
        success: 'oklch(var(--lch-ok) / <alpha-value>)',
        warning: 'oklch(var(--lch-accent) / <alpha-value>)',
        paper: { DEFAULT: 'oklch(var(--lch-paper) / <alpha-value>)', 2: 'oklch(var(--lch-paper-2) / <alpha-value>)', 3: 'oklch(var(--lch-paper-3) / <alpha-value>)' },
        ink: { DEFAULT: 'oklch(var(--lch-ink) / <alpha-value>)', 2: 'oklch(var(--lch-ink-2) / <alpha-value>)' },
        rule: { DEFAULT: 'oklch(var(--lch-rule) / <alpha-value>)', 2: 'oklch(var(--lch-rule-2) / <alpha-value>)' },
        signal: { DEFAULT: 'oklch(var(--lch-accent) / <alpha-value>)', soft: 'oklch(var(--lch-accent-soft) / <alpha-value>)', ink: 'oklch(var(--lch-accent-ink) / <alpha-value>)' },
        cool: { DEFAULT: 'oklch(var(--lch-cool) / <alpha-value>)', soft: 'oklch(var(--lch-cool-soft) / <alpha-value>)' },
        ok: { DEFAULT: 'oklch(var(--lch-ok) / <alpha-value>)', soft: 'oklch(var(--lch-ok-soft) / <alpha-value>)' },
        bad: { DEFAULT: 'oklch(var(--lch-bad) / <alpha-value>)', soft: 'oklch(var(--lch-bad-soft) / <alpha-value>)' },
        scrim: 'oklch(var(--lch-scrim) / <alpha-value>)',
        page: { DEFAULT: 'oklch(var(--lch-page) / <alpha-value>)', ink: 'oklch(var(--lch-page-ink) / <alpha-value>)' },
      },
      // One radius per level: 10px panels, 6px controls, 4px chips.
      borderRadius: {
        sm: 'var(--radius-chip)',
        md: 'var(--radius-pill)',
        lg: 'var(--radius-card)',
        xl: 'var(--radius-card)',
        '2xl': 'var(--radius-card)',
        '3xl': 'var(--radius-card)',
      },
      // Elevation is lightness and a hairline, never a drop shadow.
      boxShadow: { sm: 'none', DEFAULT: 'none', md: 'none', lg: 'none', xl: 'none', '2xl': 'none', inner: 'none' },
      transitionTimingFunction: { out: 'var(--ease-out)', in: 'var(--ease-in)', 'in-out': 'var(--ease-in-out)', smooth: 'var(--ease-out)' },
      transitionDuration: { micro: 'var(--dur-micro)', short: 'var(--dur-short)', long: 'var(--dur-long)' },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'pulse-dot': { '0%, 80%, 100%': { opacity: '0.25' }, '40%': { opacity: '1' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': { from: { opacity: '0', transform: 'translateY(6px) scale(0.98)' }, to: { opacity: '1', transform: 'translateY(0) scale(1)' } },
        'slide-down': { from: { opacity: '0', transform: 'translateY(-6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        indeterminate: { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(250%)' } },
        eq: { '0%, 100%': { transform: 'scaleY(0.25)' }, '50%': { transform: 'scaleY(1)' } },
      },
      // Motion is state: arrivals on --ease-out, loaders only loop.
      animation: {
        'fade-up': 'fade-up var(--dur-long) var(--ease-out) both',
        'pulse-dot': 'pulse-dot 1.4s var(--ease-in-out) infinite',
        'fade-in': 'fade-in var(--dur-short) var(--ease-out) both',
        'scale-in': 'scale-in var(--dur-short) var(--ease-out) both',
        'slide-down': 'slide-down var(--dur-short) var(--ease-out) both',
        indeterminate: 'indeterminate 1.3s var(--ease-in-out) infinite',
        eq: 'eq 0.9s var(--ease-in-out) infinite',
      },
    },
  },
  plugins: [animate, typography],
} satisfies Config

export default config
