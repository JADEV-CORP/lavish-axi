// Theme presets for the editor chrome (#3268), after the T3 gallery the owner shared: each preset
// tints the shadcn tokens around one hue and has a light and a dark side. This module is the only
// list: the server serves the CSS it builds, the head bootstrap checks stored ids against it, and
// the chrome draws each preset's two orbs from it.

const round = (value) => Math.round(value * 1000) / 1000;
const oklch = (l, c, h, alpha) => `oklch(${round(l)} ${round(c)} ${round(h)}${alpha ? ` / ${alpha}` : ""})`;

// Lavish's own palette (shadcn preset b50eA1ekc) is the default. chrome.css already declares it, so
// it is never emitted as an override (`builtIn`); the values here feed Copy theme CSS and must match.
const LAVISH = {
  id: "lavish",
  name: "Lavish",
  builtIn: true,
  primaryForeground: "oklch(0.969 0.015 12.422)",
  tokens: {
    "--background": ["oklch(1 0 0)", "oklch(0.145 0.008 326)"],
    "--foreground": ["oklch(0.145 0.008 326)", "oklch(0.985 0 0)"],
    "--card": ["oklch(1 0 0)", "oklch(0.212 0.019 322.12)"],
    "--popover": ["oklch(1 0 0)", "oklch(0.212 0.019 322.12)"],
    "--sidebar": ["oklch(0.985 0 0)", "oklch(0.21 0.006 285.885)"],
    "--secondary": ["oklch(0.967 0.001 286.375)", "oklch(0.274 0.006 286.033)"],
    "--muted": ["oklch(0.96 0.003 325.6)", "oklch(0.263 0.024 320.12)"],
    "--muted-foreground": ["oklch(0.542 0.034 322.5)", "oklch(0.711 0.019 323.02)"],
    "--border-color": ["oklch(0.922 0.005 325.62)", "oklch(1 0 0 / 10%)"],
    "--input": ["oklch(0.922 0.005 325.62)", "oklch(1 0 0 / 15%)"],
    "--primary": ["oklch(0.514 0.222 16.935)", "oklch(0.455 0.188 13.697)"],
    "--primary-hover": ["oklch(0.455 0.188 13.697)", "oklch(0.514 0.222 16.935)"],
    "--ring": ["oklch(0.711 0.019 323.02)", "oklch(0.542 0.034 322.5)"],
    "--accent-text": ["oklch(0.514 0.222 16.935)", "oklch(0.75 0.15 14)"],
    "--accent-text-hover": ["oklch(0.455 0.188 13.697)", "oklch(0.82 0.12 14)"],
  },
  orb: {
    light: { surface: "oklch(1 0 0)", primary: "oklch(0.514 0.222 16.935)" },
    dark: { surface: "oklch(0.145 0.008 326)", primary: "oklch(0.455 0.188 13.697)" },
  },
};

// One hue drives a preset. `tint` scales how much of it the neutrals take; `surfaceHue` lets the
// neutrals lean somewhere else (Grove's cream paper under a green accent).
function tintedPreset(id, name, { hue, surfaceHue = hue, tint = 1, light, dark }) {
  const t = (chroma) => chroma * tint;
  const s = surfaceHue;
  const tokens = {
    "--background": [oklch(0.995, t(0.004), s), oklch(0.155, t(0.02), s)],
    "--foreground": [oklch(0.16, t(0.02), s), oklch(0.975, t(0.005), s)],
    "--card": ["oklch(1 0 0)", oklch(0.205, t(0.025), s)],
    "--popover": ["oklch(1 0 0)", oklch(0.205, t(0.025), s)],
    "--sidebar": [oklch(0.982, t(0.008), s), oklch(0.19, t(0.024), s)],
    "--secondary": [oklch(0.962, t(0.012), s), oklch(0.26, t(0.03), s)],
    "--muted": [oklch(0.962, t(0.012), s), oklch(0.26, t(0.03), s)],
    "--muted-foreground": [oklch(0.53, t(0.035), s), oklch(0.72, t(0.03), s)],
    "--border-color": [oklch(0.915, t(0.012), s), "oklch(1 0 0 / 10%)"],
    "--input": [oklch(0.915, t(0.012), s), "oklch(1 0 0 / 15%)"],
    "--primary": [oklch(light.l, light.c, hue), oklch(dark.l, dark.c, hue)],
    "--primary-hover": [oklch(light.l - 0.06, light.c, hue), oklch(dark.l + 0.06, dark.c, hue)],
    "--ring": [oklch(light.l + 0.12, light.c * 0.7, hue), oklch(dark.l - 0.04, dark.c * 0.7, hue)],
    "--accent-text": [oklch(light.l, light.c, hue), oklch(0.8, Math.min(dark.c, 0.13), hue)],
    "--accent-text-hover": [oklch(light.l - 0.06, light.c, hue), oklch(0.86, Math.min(dark.c, 0.1), hue)],
  };
  return {
    id,
    name,
    tokens,
    primaryForeground: oklch(0.985, 0.01, hue),
    orb: {
      light: { surface: tokens["--background"][0], primary: tokens["--primary"][0] },
      dark: { surface: tokens["--sidebar"][1], primary: tokens["--primary"][1] },
    },
  };
}

export const THEME_PRESETS = [
  LAVISH,
  tintedPreset("t3-code", "T3 Code", {
    hue: 280,
    surfaceHue: 268,
    tint: 1.2,
    light: { l: 0.54, c: 0.16 },
    dark: { l: 0.54, c: 0.15 },
  }),
  tintedPreset("t3-chat", "T3 Chat", {
    hue: 352,
    surfaceHue: 345,
    tint: 1.6,
    light: { l: 0.56, c: 0.2 },
    dark: { l: 0.5, c: 0.19 },
  }),
  tintedPreset("grove", "Grove", {
    hue: 152,
    surfaceHue: 120,
    tint: 1,
    light: { l: 0.52, c: 0.12 },
    dark: { l: 0.54, c: 0.12 },
  }),
  tintedPreset("ocean", "Ocean", {
    hue: 235,
    surfaceHue: 228,
    tint: 1.3,
    light: { l: 0.54, c: 0.13 },
    dark: { l: 0.54, c: 0.12 },
  }),
  tintedPreset("ember", "Ember", {
    hue: 45,
    surfaceHue: 55,
    tint: 1.2,
    light: { l: 0.55, c: 0.15 },
    dark: { l: 0.55, c: 0.14 },
  }),
  tintedPreset("iris", "Iris", {
    hue: 295,
    surfaceHue: 295,
    tint: 1.4,
    light: { l: 0.54, c: 0.18 },
    dark: { l: 0.54, c: 0.17 },
  }),
];

export const DEFAULT_THEME_PRESET = LAVISH.id;
export const THEME_PRESET_IDS = THEME_PRESETS.map((preset) => preset.id);

// One preset's tokens as declarations, each holding its light and its dark value in light-dark()
// so the existing color-scheme switch picks the side.
export function themePresetDeclarations(preset) {
  if (!preset) return "";
  const lines = Object.entries(preset.tokens).map(
    ([name, [light, dark]]) => `  ${name}: light-dark(${light}, ${dark});`,
  );
  lines.push(`  --primary-foreground: ${preset.primaryForeground};`);
  return lines.join("\n");
}

// Appended to /chrome.css. The attribute selector outranks :root, so a preset overrides the
// defaults and everything derived from them (--accent, --bg-panel, ...) follows.
export function themePresetCss() {
  return THEME_PRESETS.filter((preset) => !preset.builtIn)
    .map((preset) => `:root[data-preset="${preset.id}"] {\n${themePresetDeclarations(preset)}\n}`)
    .join("\n");
}

// What the chrome needs to draw the picker and tint the artifact overlay.
export function themePresetSummaries() {
  return THEME_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    orb: preset.orb,
    css: `:root {\n${themePresetDeclarations(preset)}\n}`,
  }));
}
