import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const viewer = readFileSync(join(__dirname, '..', 'app', 'viewer.tsx'), 'utf8');

// A back swipe removed the reel only once its transition was over, and its
// video kept its sound until then: heard on the iPhone for up to a second after
// the reel had gone.
describe('the reel is silent from the moment it starts to leave', () => {
  it('reads whether it is leaving from its own navigation transition', () => {
    expect(viewer).toContain("import { useScreenLeaving } from '@/lib/use-screen-leaving';");
    expect(viewer).toContain('const leaving = useScreenLeaving();');
    expect(viewer).toContain('<ViewerLeavingContext.Provider value={leaving}>');
  });

  it('mutes every slide’s player while leaving, and only mutes it', () => {
    const effect = viewer.slice(viewer.indexOf('const leaving = useContext(ViewerLeavingContext);'));
    expect(effect.slice(0, 200)).toContain('player.muted = !active || audioMuted || leaving;');
    expect(effect.slice(0, 200)).toContain('}, [active, audioMuted, leaving, player]);');
    // The picture keeps moving into the tile the reel shrinks back to.
    expect(effect.slice(0, 200)).not.toContain('pause()');
  });
});
