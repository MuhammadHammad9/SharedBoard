/**
 * Tailwind 3.x pipeline — conflict C-8, rule R-PREC-017.
 *
 * NOT the v4 `@tailwindcss/postcss` plugin. TRD §1.1 specifies Tailwind 3.x,
 * and `design-taste-frontend` §3.A's v4 guidance is void in this repository.
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
