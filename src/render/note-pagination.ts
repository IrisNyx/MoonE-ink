/** DOM-measured, source-preserving pagination for the production note paper. */
export interface NoteFragment {
  paragraphIndex: number;
  /** UTF-16 offsets into one immutable derived paragraph; end is exclusive. */
  start: number;
  end: number;
  text: string;
  continuedBefore: boolean;
  continuedAfter: boolean;
}

export interface NoteMeasure {
  fits: boolean;
  /** Complete visual-line ends, relative to each fragment, in UTF-16 offsets. */
  lineEnds: number[][];
}

export class NotePaginationError extends Error {
  constructor(public readonly code: 'invalid_input' | 'render_overflow' | 'render_failed', message: string) {
    super(message);
    this.name = 'NotePaginationError';
  }
}

type Measure = (fragments: NoteFragment[], options: { pageIndex: number; final: boolean }) => Promise<NoteMeasure>;

/**
 * Paragraphs are tried whole first.  Only an oversized paragraph may split,
 * and only at a measured grapheme-aligned visual line with two complete lines
 * on both sides.  The callback must render all supplied text without clipping.
 */
export async function paginateNote(
  paragraphs: readonly string[],
  measure: Measure,
  options: { maxPages: number; minLinesAtSplit: number },
): Promise<NoteFragment[][]> {
  const { maxPages, minLinesAtSplit: minLines } = options;
  const fail = (code: NotePaginationError['code'], message: string): never => {
    throw new NotePaginationError(code, message);
  };
  if (!paragraphs.length || paragraphs.some((paragraph) => typeof paragraph !== 'string')) {
    fail('invalid_input', 'note body must contain at least one string paragraph');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || !Number.isSafeInteger(minLines) || minLines < 2) {
    fail('invalid_input', 'note pagination limits are invalid');
  }

  const source = [...paragraphs];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const boundaries = source.map((paragraph) => {
    const result = new Set<number>([0]);
    for (const segment of segmenter.segment(paragraph)) result.add(segment.index + segment.segment.length);
    return result;
  });
  const fragment = (paragraphIndex: number, start: number, end = source[paragraphIndex]!.length): NoteFragment => ({
    paragraphIndex,
    start,
    end,
    text: source[paragraphIndex]!.slice(start, end),
    continuedBefore: start > 0,
    continuedAfter: end < source[paragraphIndex]!.length,
  });
  const cache = new Map<string, NoteMeasure>();
  const measured = async (fragments: NoteFragment[], pageIndex: number, final: boolean): Promise<NoteMeasure> => {
    const key = `${pageIndex}:${final ? 1 : 0}:${fragments.map((item) => `${item.paragraphIndex},${item.start},${item.end}`).join(';')}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const raw = await measure(fragments.map((item) => ({ ...item })), { pageIndex, final });
    if (typeof raw?.fits !== 'boolean' || !Array.isArray(raw.lineEnds) || raw.lineEnds.length !== fragments.length) {
      fail('render_failed', 'note renderer returned an invalid measurement');
    }
    const lineEnds = raw.lineEnds.map((ends, index) => {
      const item = fragments[index]!;
      if (!Array.isArray(ends)) fail('render_failed', 'note line measurements are invalid');
      if (item.text.length === 0) {
        if (ends.length !== 0 && !(ends.length === 1 && ends[0] === 0)) {
          fail('render_failed', 'empty note paragraph has an invalid line measurement');
        }
        return [0];
      }
      let previous = 0;
      for (const end of ends) {
        if (!Number.isSafeInteger(end) || end <= previous || end > item.text.length ||
            !boundaries[item.paragraphIndex]!.has(item.start + end)) {
          fail('render_failed', 'note line measurement cuts a grapheme or is out of order');
        }
        previous = end;
      }
      if (previous !== item.text.length) fail('render_failed', 'note line measurement does not cover its fragment');
      return [...ends];
    });
    const result = { fits: raw.fits, lineEnds };
    cache.set(key, result);
    return result;
  };

  const pages: NoteFragment[][] = [];
  let current: NoteFragment[] = [];
  let paragraphIndex = 0;
  let start = 0;
  const requireAnotherPage = () => {
    if (pages.length + 1 >= maxPages) fail('render_overflow', `note exceeds the ${maxPages}-page service limit`);
  };
  const closePage = () => {
    requireAnotherPage();
    if (!current.length) fail('render_failed', 'note paginator attempted to create an empty page');
    pages.push(current);
    current = [];
  };

  while (paragraphIndex < source.length) {
    const pageIndex = pages.length;
    const remaining = fragment(paragraphIndex, start);
    const isLastParagraph = paragraphIndex === source.length - 1;
    const whole = await measured([...current, remaining], pageIndex, isLastParagraph);
    if (whole.fits) {
      current.push(remaining);
      paragraphIndex += 1;
      start = 0;
      continue;
    }
    requireAnotherPage();
    if (current.length) {
      const nextWhole = await measured([remaining], pageIndex + 1, isLastParagraph);
      if (nextWhole.fits) {
        closePage();
        continue;
      }
    }

    const ends = whole.lineEnds[current.length]!;
    const candidates = ends.slice(minLines - 1, ends.length - minLines);
    let low = 0;
    let high = candidates.length - 1;
    let selected: NoteFragment | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const split = start + candidates[middle]!;
      const head = fragment(paragraphIndex, start, split);
      const tail = fragment(paragraphIndex, split);
      const headMeasure = await measured([...current, head], pageIndex, false);
      if (!headMeasure.fits) {
        high = middle - 1;
        continue;
      }
      if (headMeasure.lineEnds[current.length]!.length < minLines) {
        low = middle + 1;
        continue;
      }
      const tailMeasure = await measured([tail], pageIndex + 1, isLastParagraph);
      if (tailMeasure.lineEnds[0]!.length < minLines) {
        high = middle - 1;
        continue;
      }
      selected = head;
      low = middle + 1;
    }
    if (selected !== undefined) {
      current.push(selected);
      start = selected.end;
      closePage();
      continue;
    }
    if (current.length) {
      closePage();
      continue;
    }
    fail('render_overflow', `note paragraph ${paragraphIndex + 1} cannot fit with the required split lines`);
  }
  if (current.length) pages.push(current);

  let expectedParagraph = 0;
  let expectedStart = 0;
  for (const page of pages) {
    if (!page.length) fail('render_failed', 'note pagination contains an empty page');
    for (const item of page) {
      const paragraph = source[expectedParagraph]!;
      if (paragraph === undefined) fail('render_failed', 'note pagination refers to a missing paragraph');
      if (item.paragraphIndex !== expectedParagraph || item.start !== expectedStart ||
          item.end < item.start || item.end > paragraph.length ||
          (item.end === item.start && paragraph !== '') || item.text !== paragraph.slice(item.start, item.end) ||
          !boundaries[expectedParagraph]!.has(item.start) || !boundaries[expectedParagraph]!.has(item.end)) {
        fail('render_failed', 'note pagination does not exactly cover the source');
      }
      expectedStart = item.end;
      if (expectedStart === paragraph.length) {
        expectedParagraph += 1;
        expectedStart = 0;
      }
    }
  }
  if (expectedParagraph !== source.length || expectedStart !== 0) {
    fail('render_failed', 'note pagination omitted source text');
  }
  const verified: NoteMeasure[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const result = await measured(pages[index]!, index, index === pages.length - 1);
    if (!result.fits) fail('render_failed', `note page ${index + 1} failed final layout validation`);
    verified.push(result);
    if (index > 0 && pages[index - 1]!.at(-1)!.paragraphIndex === pages[index]![0]!.paragraphIndex &&
        (verified[index - 1]!.lineEnds.at(-1)!.length < minLines || result.lineEnds[0]!.length < minLines)) {
      fail('render_failed', 'note split violates the minimum complete-line rule');
    }
  }
  return pages;
}
