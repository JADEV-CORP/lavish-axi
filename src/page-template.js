import { DESIGN_CDN_SNIPPET } from "./design-reference.js";

// The one starting page every agent copies (`lavish-axi design --template`), so review pages share
// a layout instead of each agent inventing its own: a header that states the outcome, sections of
// DaisyUI parts on the Lavish theme, a decision card, and quiet sources. `lavish-auto` keeps it
// adaptive: on its own it follows the OS, inside Lavish the editor's light/dark mode and preset.
// Placeholders are in square brackets; everything else is meant to stay.
export const PAGE_TEMPLATE = `<!doctype html>
<html lang="en" data-theme="lavish-auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>[Short page title]</title>
${DESIGN_CDN_SNIPPET}
</head>
<body class="min-h-screen bg-base-100 text-base-content antialiased">
<main class="mx-auto max-w-4xl space-y-12 px-6 py-12">

  <!-- Header: what this page is about, stated as an outcome. -->
  <header class="space-y-3">
    <p class="text-xs font-semibold uppercase tracking-wider text-base-content/60">[Context, e.g. AB#1234 · Review]</p>
    <h1 class="text-3xl font-semibold tracking-tight text-balance">[A full sentence that states the outcome]</h1>
    <p class="max-w-prose text-lg text-base-content/70">[Two or three sentences: what changed or what needs deciding, and why it matters.]</p>
  </header>

  <!-- Key numbers. Drop this block when there are none. -->
  <section aria-label="At a glance" class="grid gap-px border border-base-300 bg-base-300 sm:grid-cols-3">
    <div class="bg-base-100 p-4"><p class="text-sm text-base-content/60">[Label]</p><p class="text-2xl font-semibold">[Value]</p></div>
    <div class="bg-base-100 p-4"><p class="text-sm text-base-content/60">[Label]</p><p class="text-2xl font-semibold">[Value]</p></div>
    <div class="bg-base-100 p-4"><p class="text-sm text-base-content/60">[Label]</p><p class="text-2xl font-semibold">[Value]</p></div>
  </section>

  <!-- One section per topic. Repeat as needed. -->
  <section class="space-y-4">
    <h2 class="text-xl font-semibold tracking-tight">[Section heading]</h2>
    <p class="max-w-prose text-base-content/80">[Plain explanation.]</p>
    <div class="overflow-x-auto border border-base-300">
      <table class="table">
        <thead><tr><th>[Column]</th><th>[Before]</th><th>[After]</th></tr></thead>
        <tbody><tr><td>[Row]</td><td>[Value]</td><td>[Value]</td></tr></tbody>
      </table>
    </div>
    <div role="alert" class="alert border-warning/50 bg-warning/10 text-base-content"><span>[A risk or caveat the reviewer must see.]</span></div>
  </section>

  <!-- Decision: one card per question, answered with native controls and queued once. -->
  <section class="space-y-4">
    <h2 class="text-xl font-semibold tracking-tight">Decision</h2>
    <form class="card card-border bg-base-100" data-lavish-question="decision"
      onsubmit="event.preventDefault(); const answer = new FormData(event.currentTarget).get('decision'); if (answer) window.lavish?.queuePrompt('Decision: ' + answer, { tag: 'choice', text: 'Decision: ' + answer, element: event.currentTarget, data: { question: 'decision', answer } });">
      <div class="card-body gap-4">
        <h3 class="card-title text-base">[The question, phrased so each option answers it]</h3>
        <label class="flex cursor-pointer gap-3 border border-base-300 p-4 has-checked:border-(--color-primary) has-checked:bg-(--color-base-200)">
          <input type="radio" name="decision" value="[Option A]" class="radio radio-primary radio-sm mt-1">
          <span><span class="font-medium">[Option A]</span> <span class="badge badge-primary badge-sm">Recommended</span><br><span class="text-sm text-base-content/70">[What happens if chosen.]</span></span>
        </label>
        <label class="flex cursor-pointer gap-3 border border-base-300 p-4 has-checked:border-(--color-primary) has-checked:bg-(--color-base-200)">
          <input type="radio" name="decision" value="[Option B]" class="radio radio-primary radio-sm mt-1">
          <span><span class="font-medium">[Option B]</span><br><span class="text-sm text-base-content/70">[What happens if chosen.]</span></span>
        </label>
        <div class="card-actions justify-end"><button type="submit" class="btn btn-primary">Queue answer</button></div>
      </div>
    </form>
  </section>

  <!-- Sources and evidence, kept quiet. -->
  <footer class="border-t border-base-300 pt-6 text-sm text-base-content/60">
    <p>[Sources, evidence paths, and what was verified.]</p>
  </footer>

</main>
</body>
</html>
`;
