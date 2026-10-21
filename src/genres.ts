import { PRODUCTION_GENRE_IDS, PRODUCTION_LAYOUTS, type ProductionGenreId } from './production-catalog.js';

export interface GenreLimits {
  body_max_bytes: number;
  http_body_max_bytes: number;
  title_max_chars: number;
  subtitle_max_chars: number;
  pending_jobs_max: number;
  max_pages: number;
}

export interface GenreDescriptor {
  id: ProductionGenreId;
  supported: boolean;
  planned: boolean;
  accepted_fields: string[];
  limits: GenreLimits;
}

const LIMITS: GenreLimits = {
  body_max_bytes: 64 * 1024,
  http_body_max_bytes: 256 * 1024,
  title_max_chars: 512,
  subtitle_max_chars: 512,
  pending_jobs_max: 100,
  max_pages: 16,
};

export const GENRE_CATALOG: readonly GenreDescriptor[] = PRODUCTION_GENRE_IDS.map((id) => {
  const layouts = PRODUCTION_LAYOUTS.filter((layout) => layout.genre === id);
  const accepted = new Set(layouts.flatMap((layout) => [...layout.accepted_author_fields]));
  return {
    id,
    supported: true,
    planned: true,
    accepted_fields: [...accepted],
    limits: { ...LIMITS, max_pages: layouts.some((layout) => layout.pagination !== 'forbidden') ? 16 : 1 },
  };
});
