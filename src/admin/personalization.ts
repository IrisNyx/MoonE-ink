import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BusinessError } from '../errors.js';
import type { RenderBranding } from '../render/branding.js';
import { MASCOT_MOODS, type MascotMood } from '../domain/mascot.js';

type PersonalizationImageName = 'logo-primary.png' | 'logo-secondary.png' | 'logo-fox.png' |
  `mascot-${MascotMood}.png`;

export interface PersonalizationView {
  signatures: string[];
  signature_slots: Record<string, string>;
  logo_primary: string | null;
  logo_secondary: string | null;
  logo_fox: string | null;
  mascot_states: Record<MascotMood, string | null>;
  mascot_builtins: Record<MascotMood, string>;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PersonalizationStore {
  private readonly root: string;
  private readonly configPath: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'personalization');
    this.configPath = join(this.root, 'content.json');
  }

  view(): PersonalizationView {
    const settings = this.readSettings();
    const legacyMascot = existsSync(join(this.root, 'logo-fox.png'));
    return {
      signatures: settings.signatures,
      signature_slots: settings.signatureSlots,
      logo_primary: existsSync(join(this.root, 'logo-primary.png')) ? '/admin/v1/console/personalization/logo-primary.png' : null,
      logo_secondary: existsSync(join(this.root, 'logo-secondary.png')) ? '/admin/v1/console/personalization/logo-secondary.png' : null,
      logo_fox: legacyMascot ? '/admin/v1/console/personalization/logo-fox.png' : null,
      mascot_states: Object.fromEntries(MASCOT_MOODS.map((mood) => [
        mood,
        existsSync(join(this.root, `mascot-${mood}.png`))
          ? `/admin/v1/console/personalization/mascot-${mood}.png`
          : mood === 'normal' && legacyMascot ? '/admin/v1/console/personalization/logo-fox.png' : null,
      ])) as Record<MascotMood, string | null>,
      mascot_builtins: Object.fromEntries(MASCOT_MOODS.map((mood) => [
        mood,
        `/admin/v1/console/personalization/builtin-mascot-${mood}.png`,
      ])) as Record<MascotMood, string>,
    };
  }

  renderBranding(): RenderBranding {
    const settings = this.readSettings();
    const primary = this.logo('logo-primary.png');
    const secondary = this.logo('logo-secondary.png');
    const fox = this.logo('logo-fox.png');
    const mascots = Object.fromEntries(MASCOT_MOODS.map((mood) => [mood, this.logo(`mascot-${mood}.png`)])) as
      Record<MascotMood, Buffer | null>;
    const revisionHash = createHash('sha256');
    revisionHash.update(JSON.stringify(settings.signatureSlots));
    if (primary !== null) revisionHash.update(primary);
    if (secondary !== null) revisionHash.update(secondary);
    if (fox !== null) revisionHash.update(fox);
    for (const mood of MASCOT_MOODS) if (mascots[mood] !== null) revisionHash.update(mascots[mood]!);
    return {
      revision: `personalization-${revisionHash.digest('hex').slice(0, 16)}`,
      signatureSlots: settings.signatureSlots,
      ...(primary === null ? {} : { primaryLogoDataUrl: `data:image/png;base64,${primary.toString('base64')}` }),
      ...(secondary === null ? {} : { secondaryLogoDataUrl: `data:image/png;base64,${secondary.toString('base64')}` }),
      ...(fox === null ? {} : { foxLogoDataUrl: `data:image/png;base64,${fox.toString('base64')}` }),
      ...(MASCOT_MOODS.every((mood) => mascots[mood] === null) ? {} : {
        mascotDataUrls: Object.fromEntries(MASCOT_MOODS.flatMap((mood) => {
          const bytes = mascots[mood];
          return bytes === null ? [] : [[mood, `data:image/png;base64,${bytes.toString('base64')}`]];
        })),
      }),
    };
  }

  private readSettings(): { signatures: string[]; signatureSlots: Record<string, string> } {
    let signatures: string[] = [];
    let signatureSlots: Record<string, string> = {};
    try {
      if (existsSync(this.configPath)) {
        const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as { signatures?: unknown; signature_slots?: unknown };
        if (Array.isArray(parsed.signatures) && parsed.signatures.every((item) => typeof item === 'string')) {
          signatures = parsed.signatures;
        }
        if (this.validSignatureSlots(parsed.signature_slots)) signatureSlots = parsed.signature_slots;
      }
    } catch {
      throw new BusinessError('storage_unavailable', 'personalization settings are unreadable', true);
    }
    return { signatures, signatureSlots };
  }

  save(input: { signatures?: unknown; signature_slots?: unknown; logo_primary?: unknown; logo_secondary?: unknown;
    logo_fox?: unknown; mascot_states?: unknown }): PersonalizationView {
    const previous = this.readSettings();
    const signatures = input.signatures === undefined ? previous.signatures : input.signatures;
    const signatureSlots = input.signature_slots === undefined ? previous.signatureSlots : input.signature_slots;
    if (!Array.isArray(signatures) || signatures.length > 20 ||
        !signatures.every((item) => typeof item === 'string' && Array.from(item).length <= 80)) {
      throw new BusinessError('invalid_input', 'signatures must be at most 20 short strings');
    }
    if (!this.validSignatureSlots(signatureSlots)) {
      throw new BusinessError('invalid_input', 'signature slots must map a genre or default to a short string');
    }
    mkdirSync(this.root, { recursive: true });
    this.writeLogo('logo-primary.png', input.logo_primary);
    this.writeLogo('logo-secondary.png', input.logo_secondary);
    this.writeLogo('logo-fox.png', input.logo_fox);
    if (input.mascot_states !== undefined) {
      if (typeof input.mascot_states !== 'object' || input.mascot_states === null || Array.isArray(input.mascot_states) ||
          Object.keys(input.mascot_states).some((key) => !(MASCOT_MOODS as readonly string[]).includes(key))) {
        throw new BusinessError('invalid_input', 'mascot states must contain only supported expression names');
      }
      const states = input.mascot_states as Record<string, unknown>;
      for (const mood of MASCOT_MOODS) {
        if (Object.hasOwn(states, mood)) {
          this.writeLogo(`mascot-${mood}.png`, states[mood]);
          if (mood === 'normal') this.writeLogo('logo-fox.png', null);
        }
      }
    }
    const temporary = `${this.configPath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ signatures, signature_slots: signatureSlots }), { encoding: 'utf8', flag: 'w' });
    renameSync(temporary, this.configPath);
    return this.view();
  }

  private validSignatureSlots(value: unknown): value is Record<string, string> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 40 && entries.every(([key, text]) =>
      /^(?:default|[a-z][a-z0-9-]{0,63})$/.test(key) && typeof text === 'string' && Array.from(text).length <= 80,
    );
  }

  logo(name: PersonalizationImageName): Buffer | null {
    const path = join(this.root, name);
    try { return existsSync(path) ? readFileSync(path) : null; }
    catch { throw new BusinessError('storage_unavailable', 'personalization logo is unreadable', true); }
  }

  private writeLogo(name: string, value: unknown): void {
    if (value === undefined) return;
    const path = join(this.root, name);
    if (value === null) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    if (typeof value !== 'string') throw new BusinessError('invalid_input', 'logo must be a PNG data URL');
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (match === null) throw new BusinessError('invalid_input', 'logo must be a PNG data URL');
    const png = Buffer.from(match[1]!, 'base64');
    if (png.length < PNG_SIGNATURE.length || png.length > 2 * 1024 * 1024 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new BusinessError('invalid_input', 'logo PNG is invalid or larger than 2 MiB');
    }
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, png, { flag: 'w' });
    renameSync(temporary, path);
  }
}
