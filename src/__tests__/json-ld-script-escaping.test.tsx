import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { JsonLd } from '@/app/components/JsonLd';

/**
 * JSON.stringify does not escape `<`, so an unescaped payload containing
 * `</script>` closes the ld+json block early and everything after it is parsed
 * as HTML. Today every caller passes build-time schema constants, but the prop
 * type accepts arbitrary data, so this guards the sink itself rather than the
 * current call sites.
 */
describe('JsonLd script escaping', () => {
  it('escapes a closing script tag so it cannot break out of the block', () => {
    const markup = renderToStaticMarkup(
      <JsonLd data={{ name: '</script><img src=x onerror=alert(1)>' }} />,
    );

    expect(markup).not.toContain('</script><img');
    expect(markup).toContain('\\u003c/script');
  });

  it('escapes every `<`, including opening tags', () => {
    const markup = renderToStaticMarkup(<JsonLd data={{ name: '<svg onload=alert(1)>' }} />);

    expect(markup).toContain('\\u003csvg');
    expect(markup.indexOf('<svg')).toBe(-1);
  });

  it('keeps the payload valid JSON with the original value intact', () => {
    const value = '</script> & "quoted" \u2014 em dash';
    const markup = renderToStaticMarkup(<JsonLd data={{ name: value }} />);

    const json = markup.replace(/^[^>]*>([\s\S]*)<\/script>$/, '$1');
    expect(JSON.parse(json)).toEqual({ name: value });
  });

  it('renders arrays of schema objects unchanged', () => {
    const data = [{ '@type': 'FAQPage' }, { '@type': 'Product' }];
    const markup = renderToStaticMarkup(<JsonLd data={data} />);

    const json = markup.replace(/^[^>]*>([\s\S]*)<\/script>$/, '$1');
    expect(JSON.parse(json)).toEqual(data);
  });

  it('still emits the ld+json content type', () => {
    const markup = renderToStaticMarkup(<JsonLd data={{ '@type': 'Organization' }} />);

    expect(markup).toContain('type="application/ld+json"');
  });
});
