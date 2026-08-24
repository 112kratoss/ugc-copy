import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('immersive viewer comment icon', () => {
  it('keeps the comment bubble transparent without changing other bare icon shadows', () => {
    const source = readFileSync('app/viewer.tsx', 'utf8');
    const commentStart = source.indexOf("if (slot.id === 'comment')");
    const commentEnd = source.indexOf("if (slot.id === 'share')", commentStart);
    const commentSource = source.slice(commentStart, commentEnd);

    expect(commentSource).toContain('fill="transparent"');
    expect(commentSource).toContain('iconShadow={false}');
    expect(source).toContain('iconShadow = true');
    expect(source).toContain('bare && iconShadow ? <IconShadow>{icon}</IconShadow> : icon');
  });
});
