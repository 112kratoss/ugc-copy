import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The details page has one presentation and one way back. These guards keep
 * the second presentation (a modal sheet) and the second exit (the host's
 * arrow leaving the screen from the details page) from quietly returning.
 */
describe('post details navigation', () => {
  const viewer = readFileSync('app/viewer.tsx', 'utf8');
  const textPost = readFileSync('app/post/[id].tsx', 'utf8');
  const page = readFileSync('components/post-details-page.tsx', 'utf8');

  it('presents the details page only as the reel\'s swipe-left slide', () => {
    expect(viewer).not.toContain('ViewerDetailsSheet');
    expect(viewer).not.toContain('detailsSheetOpenItemId');
    expect(viewer).toContain('activeSlideRef.current?.openDetails()');
  });

  it('sends hardware back to the media or the post while the details page is showing', () => {
    for (const host of [viewer, textPost]) {
      expect(host).toContain('useHardwareBack(isFocused &&');
      expect(host).toContain('useIsFocused()');
    }
    expect(viewer).toContain('activeSlideRef.current?.showMedia()');
  });

  it('lets the page draw its own header instead of the hosts\' floating arrow', () => {
    expect(page).toContain('<DetailsHeader');
    expect(viewer).toContain('{detailsOpenForActive ? null : (');
    expect(textPost).toContain('{onDetailsPage ? null : <BackControl topInset={topInset} />}');
  });

  it('reserves no room for the retired swipe hint', () => {
    expect(page).not.toContain('Swipe right for media');
    expect(page).not.toContain('bottomInset + 84');
  });
});
