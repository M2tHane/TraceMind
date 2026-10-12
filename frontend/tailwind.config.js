const v = name => `var(--${name})`

// Layout utilities come from Tailwind; colours, radii and shadows map onto the design tokens in src/styles/tokens.css.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        app: v('bg-app'),
        sidebar: v('bg-sidebar'),
        subtle: v('bg-subtle'),
        selected: v('bg-selected'),
        card: v('bg-card'),
        line: { DEFAULT: v('border'), strong: v('border-strong') },
        t1: v('text-1'),
        t2: v('text-2'),
        t3: v('text-3'),
        inverse: { DEFAULT: v('inverse-bg'), fg: v('inverse-fg') },
        action: { DEFAULT: v('action'), text: v('action-text'), soft: v('action-soft') },
        danger: { DEFAULT: v('danger'), soft: v('danger-soft') },
      },
      fontFamily: { sans: [v('font-sans')], mono: [v('font-mono')] },
      fontSize: { xs: ['12px', '18px'], sm: ['13px', '20px'], base: ['13px', '20px'], md: ['15px', '24px'], title: ['18px', '26px'] },
      borderRadius: { control: v('radius-control'), panel: v('radius-panel'), dialog: v('radius-dialog') },
      boxShadow: { sm: v('shadow-sm'), md: v('shadow-md'), lg: v('shadow-lg') },
      spacing: { bar: v('header-height'), rail: v('rail-width'), side: v('sidebar-width') },
    },
  },
  plugins: [],
}
