import {
  dustTile,
  grainAt,
  INTRO_PIECES,
  INTRO_WORDS,
  introBlockWidth,
  introLines,
  introTypeScale,
  NOTE_LINE,
  NOTE_SIZE,
  NOTE_WEIGHT,
  TILE,
  WORD_LINE,
  WORD_SIZE,
  WORD_TRACKING,
  WORD_WEIGHT,
  wordFrame,
  type DustTile,
  type IntroLine,
  type IntroPiece,
  type IntroTone,
} from '@/lib/first-sign-up-intro-timeline';

/**
 * The first sign-up intro's words, drawn on one canvas from their arrival to
 * the end of the dust (`FirstSignUpIntro.tsx` runs the clock).
 *
 * Each word and each note is drawn once into an atlas, at the screen's pixel
 * density. The arrival draws those pictures with their fade, rise and writing;
 * the dust cuts the same pictures into tiles and throws each one (the app's
 * throw, `grainAt`). Words and dust come from the same pixels, and a tile at
 * rest sits on whole device pixels, so the change from words to dust is never
 * seen. The tiles that hold no ink are left out.
 */

export type IntroFaces = { display: string; handwriting: string };
export type IntroInk = Record<IntroTone, string> & { note: string };

/** Denser screens draw at most this many device px per CSS px. */
const MAX_DENSITY = 3;
/** Room around each picture for ink past the text's box (a slanted letter's tail). */
const PAD = 3;
/** Alpha above this counts as ink when the empty tiles are left out. */
const INK = 8;

type Tile = DustTile & { sx: number; sy: number; sw: number; sh: number };

type Piece = {
  meta: IntroPiece;
  /** The text's advance, in CSS px. */
  advance: number;
  /** The picture's top-left from its line box's top-left, in CSS px. */
  left: number;
  top: number;
  /** Its place in the atlas, in device px. */
  atlasY: number;
  width: number;
  height: number;
  tiles: Tile[];
};

type PieceStyle = { font: string; line: number; tracking: number; color: string };

function pieceStyle(meta: IntroPiece, scale: number, faces: IntroFaces, ink: IntroInk): PieceStyle {
  if (meta.kind === 'word') {
    return {
      font: `${WORD_WEIGHT} ${WORD_SIZE * scale}px ${faces.display}`,
      line: WORD_LINE * scale,
      tracking: WORD_TRACKING * scale,
      color: ink[INTRO_WORDS[meta.index].tone],
    };
  }
  return { font: `${NOTE_WEIGHT} ${NOTE_SIZE * scale}px ${faces.handwriting}`, line: NOTE_LINE * scale, tracking: 0, color: ink.note };
}

/** Sets the style; true when the browser spaces the letters itself. */
function applyStyle(context: CanvasRenderingContext2D, style: PieceStyle): boolean {
  context.font = style.font;
  context.textBaseline = 'alphabetic';
  context.textAlign = 'left';
  context.fillStyle = style.color;
  if ('letterSpacing' in context) {
    context.letterSpacing = `${style.tracking}px`;
    return true;
  }
  return style.tracking === 0;
}

function fillTracked(context: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number, native: boolean) {
  if (native) {
    context.fillText(text, x, y);
    return;
  }
  // A browser without canvas letter spacing: each letter placed by the width
  // of the text before it, so the pairs keep their kerning.
  let before = '';
  for (const letter of text) {
    context.fillText(letter, x + context.measureText(before).width + tracking * [...before].length, y);
    before += letter;
  }
}

function measurePiece(context: CanvasRenderingContext2D, meta: IntroPiece, style: PieceStyle) {
  const native = applyStyle(context, style);
  const metrics = context.measureText(meta.text);
  const advance = native ? metrics.width : metrics.width + style.tracking * [...meta.text].length;
  // The line box as CSS lays it out: the face's ascent and descent centred in the line height.
  const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
  const baseline = (style.line - (ascent + descent)) / 2 + ascent;
  const left = Math.min(0, -metrics.actualBoundingBoxLeft) - PAD;
  const right = Math.max(advance, metrics.actualBoundingBoxRight) + PAD;
  const top = Math.min(0, baseline - metrics.actualBoundingBoxAscent) - PAD;
  const bottom = Math.max(style.line, baseline + metrics.actualBoundingBoxDescent) + PAD;
  return { native, advance, baseline, left, top, width: right - left, height: bottom - top };
}

export type IntroStage = {
  /** Lays the words out for the window; the pictures are redrawn only when the size or density changed. */
  layout(viewport: { width: number; height: number }, density: number): void;
  /**
   * Draws every picture once and clears it again in the same task, so it is
   * never seen: the atlas reaches the GPU before the clock starts, not in the
   * first word's fade.
   */
  warm(): void;
  /** The arrival, the writing and the hold, `elapsed` ms into the timeline. */
  drawWords(elapsed: number): void;
  /** The dust, `snap` (0 to 1) of the way through. */
  drawDust(snap: number): void;
  /** Lets go of every pixel: the canvas, the atlas and the tiles. */
  release(): void;
};

export function createIntroStage(
  canvas: HTMLCanvasElement,
  { faces, ink, calm }: { faces: IntroFaces; ink: IntroInk; calm: boolean },
): IntroStage | null {
  const context = canvas.getContext('2d');
  const atlas = document.createElement('canvas');
  const atlasContext = atlas.getContext('2d', { willReadFrequently: true });
  if (!context || !atlasContext) return null;

  let scale = 0;
  let density = 0;
  let pieces: Piece[] = [];
  let lines: IntroLine[] = [];
  let atOne: { words: number[]; notes: number[] } | null = null;

  const measureAtOne = () => {
    const advances = INTRO_PIECES.map((meta) => measurePiece(atlasContext, meta, pieceStyle(meta, 1, faces, ink)).advance);
    return {
      words: advances.filter((_, index) => INTRO_PIECES[index].kind === 'word'),
      notes: advances.filter((_, index) => INTRO_PIECES[index].kind === 'note'),
    };
  };

  const build = () => {
    const measured = INTRO_PIECES.map((meta) => {
      const style = pieceStyle(meta, scale, faces, ink);
      return { meta, style, box: measurePiece(atlasContext, meta, style) };
    });
    let y = 0;
    pieces = measured.map(({ meta, box }) => {
      const piece: Piece = {
        meta,
        advance: box.advance,
        left: box.left,
        top: box.top,
        atlasY: y,
        width: Math.ceil(box.width * density),
        height: Math.ceil(box.height * density),
        tiles: [],
      };
      y += piece.height + 2;
      return piece;
    });
    // Resizing clears the atlas and its state.
    atlas.width = Math.max(...pieces.map((piece) => piece.width));
    atlas.height = Math.max(1, y);
    measured.forEach(({ style, box }, index) => {
      atlasContext.setTransform(density, 0, 0, density, 0, pieces[index].atlasY);
      const native = applyStyle(atlasContext, style);
      fillTracked(atlasContext, INTRO_PIECES[index].text, -box.left, -box.top + box.baseline, style.tracking, native);
    });
    atlasContext.setTransform(1, 0, 0, 1, 0, 0);
    if (calm) return;

    // The dust: each picture cut into tiles on whole device pixels, the empty ones left out.
    const tile = Math.max(2, Math.round(TILE * scale * density));
    const { data } = atlasContext.getImageData(0, 0, atlas.width, atlas.height);
    const inked = (x0: number, y0: number, w: number, h: number) => {
      for (let row = y0; row < y0 + h; row += 1) {
        for (let col = x0; col < x0 + w; col += 1) {
          if (data[(row * atlas.width + col) * 4 + 3] > INK) return true;
        }
      }
      return false;
    };
    for (const piece of pieces) {
      const cols = Math.ceil(piece.width / tile);
      const rows = Math.ceil(piece.height / tile);
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const sx = col * tile;
          const sy = row * tile;
          const sw = Math.min(tile, piece.width - sx);
          const sh = Math.min(tile, piece.height - sy);
          if (!inked(sx, piece.atlasY + sy, sw, sh)) continue;
          piece.tiles.push({ ...dustTile(col, row, cols, piece.meta.seedBase, piece.meta.sweepDelay), sx, sy, sw, sh });
        }
      }
    }
  };

  /** A picture's top-left on the canvas at rest, on whole device pixels. */
  const restingAt = (piece: Piece) => {
    const line = lines[piece.meta.index];
    const x = piece.meta.kind === 'word' ? line.wordX : line.noteX;
    const y = piece.meta.kind === 'word' ? line.wordY : line.noteY;
    return { x: Math.round((x + piece.left) * density), y: Math.round((y + piece.top) * density) };
  };

  const clear = () => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.clearRect(0, 0, canvas.width, canvas.height);
  };

  return {
    layout(viewport, screenDensity) {
      const nextDensity = Math.min(MAX_DENSITY, Math.max(1, screenDensity || 1));
      atOne ??= measureAtOne();
      const nextScale = introTypeScale(viewport, introBlockWidth(atOne.words, atOne.notes));
      if (nextScale !== scale || nextDensity !== density) {
        scale = nextScale;
        density = nextDensity;
        build();
      }
      canvas.width = Math.round(viewport.width * density);
      canvas.height = Math.round(viewport.height * density);
      const advances = (kind: IntroPiece['kind']) => pieces.filter((piece) => piece.meta.kind === kind).map((piece) => piece.advance);
      lines = introLines(viewport, scale, advances('word'), advances('note'));
    },

    warm() {
      this.drawWords(Number.MAX_SAFE_INTEGER);
      clear();
    },

    drawWords(elapsed) {
      clear();
      for (let index = 0; index < INTRO_WORDS.length; index += 1) {
        const frame = wordFrame(index, elapsed, calm);
        const word = pieces[index * 2];
        const note = pieces[index * 2 + 1];
        if (frame.opacity > 0) {
          const at = restingAt(word);
          context.globalAlpha = frame.opacity;
          // Off the pixel grid only while it moves.
          const y = frame.rise > 0 ? at.y + frame.rise * scale * density : at.y;
          context.drawImage(atlas, 0, word.atlasY, word.width, word.height, at.x, y, word.width, word.height);
        }
        if (frame.noteOpacity > 0 && frame.written > 0) {
          // Written left to right: the picture shown up to where the pen has reached.
          const at = restingAt(note);
          const shown = Math.max(1, Math.round(note.width * frame.written));
          context.globalAlpha = frame.noteOpacity;
          context.drawImage(atlas, 0, note.atlasY, shown, note.height, at.x, at.y, shown, note.height);
        }
      }
      context.globalAlpha = 1;
    },

    drawDust(snap) {
      clear();
      for (const piece of pieces) {
        const at = restingAt(piece);
        for (const tile of piece.tiles) {
          const grain = grainAt(tile, snap);
          if (!grain) continue;
          const cos = Math.cos(grain.rotate) * grain.scale;
          const sin = Math.sin(grain.rotate) * grain.scale;
          // Turned and shrunk about its own centre, then carried.
          const cx = at.x + tile.sx + tile.sw / 2 + grain.x * scale * density;
          const cy = at.y + tile.sy + tile.sh / 2 + grain.y * scale * density;
          context.setTransform(cos, sin, -sin, cos, cx, cy);
          context.globalAlpha = grain.opacity;
          context.drawImage(atlas, tile.sx, piece.atlasY + tile.sy, tile.sw, tile.sh, -tile.sw / 2, -tile.sh / 2, tile.sw, tile.sh);
        }
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
    },

    release() {
      pieces = [];
      canvas.width = 0;
      canvas.height = 0;
      atlas.width = 0;
      atlas.height = 0;
    },
  };
}
