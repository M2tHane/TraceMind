const v = name => `var(--tm-${name})`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        surface: { DEFAULT: v('surface'), 2: v('surface-2'), 3: v('surface-3') },
        rail: { DEFAULT: v('rail'), line: v('rail-line') },
        hover: v('hover'),
        ink: { DEFAULT: v('ink'), hover: v('ink-hover'), 2: v('text-2'), 3: v('text-3') },
        muted: v('muted'),
        faint: v('faint'),
        line: { DEFAULT: v('line'), soft: v('line-soft') },
        control: v('control'),
        pine: { DEFAULT: v('pine'), hover: v('pine-hover'), tint: v('pine-tint'), 'tint-text': v('pine-tint-text') },
        bubble: { user: v('bubble-user'), 'user-line': v('bubble-user-line') },
        hl: v('hl'),
        cite: { DEFAULT: v('cite'), line: v('cite-line'), text: v('cite-text'), on: v('cite-on'), 'on-line': v('cite-on-line'), 'on-text': v('cite-on-text') },
        ev: { card: v('ev-card'), line: v('ev-card-line') },
        badge: v('badge'),
        danger: { DEFAULT: v('danger'), line: v('danger-line') },
        stage: { scope: v('stage-scope'), vector: v('stage-vector'), bm25: v('stage-bm25'), fusion: v('stage-fusion'), rerank: v('stage-rerank'), post: v('stage-post') },
        step: { done: v('step-done'), now: v('step-now'), todo: v('step-todo'), fail: v('step-fail') },
      },
      fontFamily: { sans: [v('font')], mono: [v('mono')] },
      fontSize: { xs: ['12px', '1.5'], sm: ['13px', '1.55'], base: ['13px', '1.55'], md: ['14px', '1.75'], title: ['17px', '1.4'] },
      borderRadius: { control: '4px', panel: '6px', bubble: '10px' },
      boxShadow: { pop: v('shadow-pop'), drawer: v('shadow-drawer') },
      spacing: { bar: v('bar-h'), rail: v('rail-w'), side: v('side-w') },
    },
  },
  plugins: [],
}
