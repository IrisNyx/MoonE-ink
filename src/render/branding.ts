import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MASCOT_MOODS, type MascotMood } from '../domain/mascot.js';

export type MascotDataUrls = Readonly<Record<MascotMood, string>>;

const MASCOT_FILES: Readonly<Record<MascotMood, string>> = {
  normal: 'rose-placeholder.png',
  happy: 'rose-placeholder.png',
  sad: 'rose-placeholder.png',
  thinking: 'rose-placeholder.png',
  sleepy: 'rose-placeholder.png',
};

let builtinMascotCache: MascotDataUrls | undefined;
let builtinMascotBytesCache: Readonly<Record<MascotMood, Buffer>> | undefined;

function mascotAssetPath(file: string): string {
  const candidates = [
    // Compiled service: dist/src/render/branding.js -> service root.
    fileURLToPath(new URL(`../../../assets/public/${file}`, import.meta.url)),
    // Direct source execution used by a few development tools.
    fileURLToPath(new URL(`../../assets/public/${file}`, import.meta.url)),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`built-in mascot asset is unavailable: ${file}`);
  return found;
}

/** Load the five public rose placeholders once; renderers embed them as data URLs. */
export function builtinMascotPngs(): Readonly<Record<MascotMood, Buffer>> {
  if (builtinMascotBytesCache !== undefined) return builtinMascotBytesCache;
  builtinMascotBytesCache = Object.fromEntries(MASCOT_MOODS.map((mood) => [
    mood,
    readFileSync(mascotAssetPath(MASCOT_FILES[mood])),
  ])) as unknown as Readonly<Record<MascotMood, Buffer>>;
  return builtinMascotBytesCache;
}

export function builtinMascotDataUrls(): MascotDataUrls {
  if (builtinMascotCache !== undefined) return builtinMascotCache;
  const pngs = builtinMascotPngs();
  builtinMascotCache = Object.fromEntries(MASCOT_MOODS.map((mood) => [
    mood,
    `data:image/png;base64,${pngs[mood].toString('base64')}`,
  ])) as unknown as MascotDataUrls;
  return builtinMascotCache;
}

export interface RenderBranding {
  revision: string;
  signatureSlots: Readonly<Record<string, string>>;
  primaryLogoDataUrl?: string;
  secondaryLogoDataUrl?: string;
  /** Per-state custom overrides. Missing states keep their owned built-in image. */
  mascotDataUrls?: Partial<MascotDataUrls>;
  /** Legacy one-image override retained for already configured installations. */
  foxLogoDataUrl?: string;
}

export function effectiveMascotDataUrls(branding: RenderBranding | undefined): MascotDataUrls {
  const builtin = builtinMascotDataUrls();
  const legacy = branding?.foxLogoDataUrl;
  return Object.fromEntries(MASCOT_MOODS.map((mood) => [
    mood,
    branding?.mascotDataUrls?.[mood] ?? (mood === 'normal' ? legacy : undefined) ?? builtin[mood],
  ])) as unknown as MascotDataUrls;
}

export function signatureForGenre(
  branding: RenderBranding | undefined,
  genre: string,
  role: 'issuer' | 'recipient' = 'issuer',
): string | undefined {
  if (role === 'recipient') {
    return branding?.signatureSlots[`${genre}-recipient`] ?? branding?.signatureSlots['default-recipient'];
  }
  return branding?.signatureSlots[`${genre}-issuer`] ?? branding?.signatureSlots[genre] ??
    branding?.signatureSlots['default-issuer'] ?? branding?.signatureSlots['default'];
}

export function publicBrandingFacts(branding: RenderBranding | undefined): {
  revision: string | null;
  primary_logo: boolean;
  secondary_logo: boolean;
  fox_logo: boolean;
} {
  return {
    revision: branding?.revision ?? null,
    primary_logo: branding?.primaryLogoDataUrl !== undefined,
    secondary_logo: branding?.secondaryLogoDataUrl !== undefined,
    fox_logo: branding?.foxLogoDataUrl !== undefined || branding?.mascotDataUrls !== undefined,
  };
}
