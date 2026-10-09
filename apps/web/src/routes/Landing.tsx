import { Link } from 'react-router'
import {
  ArrowRight,
  ArrowsOut,
  CloudSlash,
  Cursor,
  LinkSimple,
  NotePencil,
  ShieldCheck,
  Stack,
} from '@phosphor-icons/react'
import { LiveDemo } from '../components/landing/LiveDemo.js'
import { brand, landing } from '../lib/strings.js'

/**
 * S-01 Landing — FLOWS §1.2, §3.1. MARKETING zone.
 *
 * gpt-taste design plan (Phase 15a): Editorial Split hero with the live
 * two-cursor demo, a capabilities marquee, a gapless 6-column bento, a
 * sticky-pinned "guarantees" chapter with a scrubbed word reveal, and a
 * high-contrast CTA band. Overrides from RULES.md §2.3: Inter (C-1), no GSAP
 * (C-3) — pinning is `position: sticky`, the reveal is a CSS scroll-driven
 * animation — and no stock photography: every visual is the product.
 *
 * Edges (FLOWS §1.2): "Log in" → S-03, "Sign up free" → S-02, "Try it now" →
 * `/demo`, logo → S-01. An authenticated visitor never sees this page; the
 * route guard sends them to S-07.
 *
 * Motion (dials 7/6/4): a staggered rise on first paint, the marquee, the
 * word reveal and the hero loop. All four stand down under reduced motion.
 */
export default function Landing() {
  return (
    <div className="w-full max-w-full overflow-x-hidden bg-app text-primary">
      <Nav />
      <main>
        <Hero />
        <Marquee />
        <Bento />
        <Guarantees />
        <CallToAction />
      </main>
      <Footer />
    </div>
  )
}

function Wordmark() {
  return (
    <Link
      to="/"
      className="flex cursor-pointer items-center gap-2 rounded-sm text-base font-semibold text-primary outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
      data-testid="landing-logo"
    >
      <span
        aria-hidden="true"
        className="grid h-6 w-6 place-items-center rounded-sm bg-accent"
      >
        <NotePencil size={14} weight="bold" className="text-white" />
      </span>
      {brand.name}
    </Link>
  )
}

function Nav() {
  return (
    <header className="sticky top-0 z-header border-b border-border bg-app/90 backdrop-blur">
      <nav
        aria-label={landing.nav.label}
        className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-6"
      >
        <Wordmark />
        <div className="flex items-center gap-2">
          <Link
            to="/login"
            className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium text-primary outline-none transition-colors duration-fast hover:bg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="landing-login"
          >
            {landing.nav.logIn}
          </Link>
          <Link
            to="/signup"
            className="cursor-pointer rounded-md bg-accent px-3 py-2 text-sm font-medium text-white outline-none transition-[background-color,transform] duration-fast hover:bg-accent/90 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            data-testid="landing-signup-nav"
          >
            {landing.nav.signUp}
          </Link>
        </div>
      </nav>
    </header>
  )
}

/** Primary CTA with the button-in-button trailing arrow (high-end-visual-design). */
function PrimaryCta({ testId }: { testId: string }) {
  return (
    <Link
      to="/signup"
      data-testid={testId}
      className="group inline-flex cursor-pointer items-center gap-3 rounded-full bg-accent py-2 pl-6 pr-2 text-base font-medium text-white outline-none transition-[background-color,transform] duration-fast hover:bg-accent/90 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {landing.ctaPrimary}
      <span
        aria-hidden="true"
        className="grid h-8 w-8 place-items-center rounded-full bg-white/15 transition-transform duration-base ease-out group-hover:translate-x-1"
      >
        <ArrowRight size={16} weight="bold" />
      </span>
    </Link>
  )
}

function SecondaryCta({
  testId,
  inverted = false,
}: {
  testId: string
  inverted?: boolean
}) {
  return (
    <Link
      to="/demo"
      data-testid={testId}
      className={
        'inline-flex cursor-pointer items-center rounded-full border px-6 py-3 text-base font-medium outline-none ' +
        'transition-[background-color,transform] duration-fast active:scale-[0.97] ' +
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
        (inverted
          ? 'border-white/30 bg-transparent text-white hover:bg-white/10'
          : 'border-border bg-app text-primary hover:bg-subtle')
      }
    >
      {landing.ctaSecondary}
    </Link>
  )
}

function Hero() {
  return (
    <section className="relative">
      {/* The board's own dot grid, faintly — the hero sits on a canvas. */}
      <div
        aria-hidden="true"
        className="landing-dots pointer-events-none absolute inset-0"
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 md:px-6 lg:grid-cols-[1.1fr_1fr] lg:py-32">
        <div>
          <p
            data-rise
            style={{ '--i': 0 } as React.CSSProperties}
            className="mb-6 inline-flex rounded-full border border-border bg-app px-3 py-1 text-xs font-medium text-primary"
          >
            {landing.eyebrow}
          </p>
          {/* 2–3 lines at every width: clamp size, wide container. */}
          <h1
            data-rise
            style={{ '--i': 1 } as React.CSSProperties}
            className="max-w-2xl text-[clamp(2.5rem,4.2vw,4.25rem)] font-semibold leading-[1.05] tracking-tight lg:max-w-none"
          >
            {landing.headline}
          </h1>
          <p
            data-rise
            style={{ '--i': 2 } as React.CSSProperties}
            className="mt-6 max-w-xl text-lg leading-relaxed text-muted"
          >
            {landing.sub}
          </p>
          <div
            data-rise
            style={{ '--i': 3 } as React.CSSProperties}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <PrimaryCta testId="landing-signup" />
            <SecondaryCta testId="landing-demo-link" />
          </div>
        </div>

        {/* Double-Bezel: a hairline shell around a concentric inner core. */}
        <div
          data-rise
          style={{ '--i': 2 } as React.CSSProperties}
          className="rounded-lg border border-border bg-subtle p-2 shadow-panel"
        >
          <div className="rounded-md border border-border bg-canvas">
            <LiveDemo />
          </div>
        </div>
      </div>
    </section>
  )
}

function Marquee() {
  const items = landing.marquee
  const row = (hidden: boolean) => (
    <ul
      className="flex shrink-0 items-center gap-12 pr-12"
      aria-hidden={hidden || undefined}
    >
      {items.map(item => (
        <li key={item} className="whitespace-nowrap text-lg font-medium text-primary">
          {item}
        </li>
      ))}
    </ul>
  )
  return (
    <section
      className="border-y border-border bg-subtle py-6"
      aria-label={landing.bento.heading}
    >
      {/* Two identical rows; the second is presentation only, so a screen
          reader hears the list once. */}
      <div className="landing-marquee flex w-max">
        {row(false)}
        {row(true)}
      </div>
    </section>
  )
}

interface BentoCardProps {
  title: string
  body: string
  icon: React.ReactNode
  className: string
  children?: React.ReactNode
}

function BentoCard({ title, body, icon, className, children }: BentoCardProps) {
  return (
    <article
      className={`group relative flex flex-col overflow-hidden rounded-lg border border-border bg-app p-6 ${className}`}
    >
      <span
        aria-hidden="true"
        className="mb-4 grid h-9 w-9 place-items-center rounded-md bg-subtle text-accent"
      >
        {icon}
      </span>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">{body}</p>
      {children}
    </article>
  )
}

function Bento() {
  const b = landing.bento
  return (
    <section className="mx-auto max-w-6xl px-4 py-32 md:px-6 md:py-40">
      <h2 className="max-w-3xl text-[clamp(1.875rem,3vw,2.75rem)] font-semibold leading-tight tracking-tight">
        {b.heading}
      </h2>
      {/* 6 columns, 3 rows: A 4×2 + B 2×1 + C 2×1 + D 6×1 = 18 of 18 cells. */}
      <div className="mt-12 grid grid-flow-dense auto-rows-[minmax(12rem,auto)] grid-cols-1 gap-4 md:grid-cols-6">
        <BentoCard
          title={b.canvas.title}
          body={b.canvas.body}
          icon={<ArrowsOut size={20} weight="light" />}
          className="md:col-span-4 md:row-span-2"
        >
          <div
            aria-hidden="true"
            className="landing-dots relative mt-6 flex-1 rounded-md border border-border bg-canvas"
          >
            <div className="absolute left-[12%] top-[18%] h-16 w-24 rounded-sm bg-sticky-yellow transition-transform duration-slow ease-out group-hover:-translate-y-1" />
            <div className="absolute left-[44%] top-[30%] h-20 w-20 rounded-full border-4 border-presence-8 transition-transform duration-slow ease-out group-hover:scale-105" />
            <div className="absolute bottom-[18%] right-[14%] h-14 w-28 rounded-sm bg-sticky-blue transition-transform duration-slow ease-out group-hover:translate-x-1" />
          </div>
        </BentoCard>
        <BentoCard
          title={b.presence.title}
          body={b.presence.body}
          icon={<Cursor size={20} weight="light" />}
          className="md:col-span-2"
        />
        <BentoCard
          title={b.offline.title}
          body={b.offline.body}
          icon={<CloudSlash size={20} weight="light" />}
          className="md:col-span-2"
        />
        <BentoCard
          title={b.share.title}
          body={b.share.body}
          icon={<LinkSimple size={20} weight="light" />}
          className="md:col-span-6"
        />
      </div>
    </section>
  )
}

/** Each word its own span, so the reveal can scrub across the sentence. */
function Scrubbed({ text }: { text: string }) {
  const words = text.split(' ')
  return (
    <p className="landing-scrub text-xl leading-relaxed md:text-2xl">
      {words.map((word, i) => (
        <span key={i} style={{ '--w': i / words.length } as React.CSSProperties}>
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </p>
  )
}

function Guarantees() {
  const g = landing.guarantees
  const icons = [Stack, ShieldCheck, NotePencil]
  return (
    <section className="border-t border-border bg-canvas">
      <div className="mx-auto grid max-w-6xl gap-12 px-4 py-32 md:px-6 md:py-40 lg:grid-cols-[1fr_1.4fr]">
        {/* Pinned while the column beside it scrolls — sticky, not GSAP. */}
        <div className="lg:sticky lg:top-32 lg:self-start">
          <h2 className="text-[clamp(1.875rem,3vw,2.75rem)] font-semibold leading-tight tracking-tight">
            {g.heading}
          </h2>
        </div>
        <ol className="flex flex-col gap-24">
          {g.items.map((item, i) => {
            const Icon = icons[i] ?? Stack
            return (
              <li key={item.title}>
                <span
                  aria-hidden="true"
                  className="mb-4 grid h-10 w-10 place-items-center rounded-md bg-app text-accent shadow-panel"
                >
                  <Icon size={20} weight="light" />
                </span>
                <h3 className="mb-3 text-lg font-semibold">{item.title}</h3>
                <Scrubbed text={item.body} />
              </li>
            )
          })}
        </ol>
      </div>
    </section>
  )
}

function CallToAction() {
  return (
    <section className="px-4 py-32 md:px-6 md:py-40">
      <div className="mx-auto max-w-6xl rounded-lg bg-primary px-6 py-20 text-center md:px-12">
        <h2 className="mx-auto max-w-4xl text-[clamp(2rem,4vw,3.5rem)] font-semibold leading-tight tracking-tight text-white">
          {landing.cta.heading}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-white/80">{landing.cta.body}</p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <PrimaryCta testId="landing-signup-footer" />
          <SecondaryCta testId="landing-demo-footer" inverted />
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-primary md:px-6">
        <Wordmark />
        <p>
          © {new Date().getFullYear()} {landing.footer.rights}
        </p>
      </div>
    </footer>
  )
}
