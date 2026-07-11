import { describe, expect, it } from 'vitest';
import {
  dnrRuleForHost,
  gatewayUrlToOrdUri,
  normalizeOrdInput,
  uriFromDnrHash,
  uriFromViewerHash,
  viewerUrl,
} from '../src/urlmap.js';

const ID = '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0';

describe('gatewayUrlToOrdUri', () => {
  it('maps /content and /preview to the delegation-applied form', () => {
    expect(gatewayUrlToOrdUri(`https://ordinals.com/content/${ID}`)?.uri).toBe(`ord:${ID}/content`);
    expect(gatewayUrlToOrdUri(`https://ordinals.com/preview/${ID}`)?.uri).toBe(`ord:${ID}/content`);
  });

  it('maps /r/undelegated-content to the bare referent', () => {
    expect(gatewayUrlToOrdUri(`https://ordinals.com/r/undelegated-content/${ID}`)?.uri).toBe(
      `ord:${ID}`,
    );
  });

  it('accepts subdomains of configured hosts and custom host lists', () => {
    expect(gatewayUrlToOrdUri(`https://static.ordinals.com/content/${ID}`)).toBeDefined();
    expect(gatewayUrlToOrdUri(`https://my.gateway.example/content/${ID}`, ['gateway.example'])).toBeDefined();
  });

  it('rejects other hosts, paths, malformed ids, and non-http(s)', () => {
    expect(gatewayUrlToOrdUri(`https://example.com/content/${ID}`)).toBeUndefined();
    expect(gatewayUrlToOrdUri(`https://ordinals.com/inscription/${ID}`)).toBeUndefined();
    expect(gatewayUrlToOrdUri('https://ordinals.com/content/zzz')).toBeUndefined();
    expect(gatewayUrlToOrdUri(`https://ordinals.com/content/${ID}/extra`)).toBeUndefined();
    expect(gatewayUrlToOrdUri(`ftp://ordinals.com/content/${ID}`)).toBeUndefined();
    expect(gatewayUrlToOrdUri('not a url')).toBeUndefined();
  });

  it('normalizes uppercase ids', () => {
    expect(gatewayUrlToOrdUri(`https://ordinals.com/content/${ID.toUpperCase().replace('I0', 'i0')}`)?.inscriptionId).toBe(ID);
  });
});

describe('normalizeOrdInput', () => {
  it('accepts ord:, ord://, and bare ids', () => {
    expect(normalizeOrdInput(`ord:${ID}`)).toBe(`ord:${ID}`);
    expect(normalizeOrdInput(`ord://${ID}`)).toBe(`ord:${ID}`);
    expect(normalizeOrdInput(ID)).toBe(`ord:${ID}`);
    expect(normalizeOrdInput(`  ord:${ID}/content  `)).toBe(`ord:${ID}/content`);
  });

  it('keeps paths and integrity fragments intact', () => {
    expect(normalizeOrdInput(`ord:${ID}/content#integrity=sha256-${'a'.repeat(64)}`)).toBe(
      `ord:${ID}/content#integrity=sha256-${'a'.repeat(64)}`,
    );
  });

  it('rejects junk', () => {
    expect(normalizeOrdInput('hello')).toBeUndefined();
    expect(normalizeOrdInput('ord:zzz')).toBeUndefined();
    expect(normalizeOrdInput('')).toBeUndefined();
  });
});

describe('viewer hash round-trips', () => {
  it('viewerUrl → uriFromViewerHash', () => {
    const url = viewerUrl('chrome-extension://abc/', `ord:${ID}/content`);
    const hash = new URL(url).hash;
    expect(uriFromViewerHash(hash)).toBe(`ord:${ID}/content`);
  });

  it('dNR hash form decodes both kinds', () => {
    expect(uriFromDnrHash(`#gw:content:${ID}`)).toBe(`ord:${ID}/content`);
    expect(uriFromDnrHash(`#gw:preview:${ID}`)).toBe(`ord:${ID}/content`);
    expect(uriFromDnrHash(`#gw:r/undelegated-content:${ID}`)).toBe(`ord:${ID}`);
    expect(uriFromDnrHash('#gw:content:zzz')).toBeUndefined();
    expect(uriFromDnrHash(`#ord:${ID}`)).toBeUndefined();
  });
});

describe('dnrRuleForHost', () => {
  it('builds a main-frame redirect rule whose regex matches exactly the content paths', () => {
    const rule = dnrRuleForHost('ordinals.com', 7, 'chrome-extension://abc/');
    expect(rule.id).toBe(7);
    expect(rule.condition.resourceTypes).toEqual(['main_frame']);
    const re = new RegExp(rule.condition.regexFilter!);
    expect(re.test(`https://ordinals.com/content/${ID}`)).toBe(true);
    expect(re.test(`https://ordinals.com/r/undelegated-content/${ID}`)).toBe(true);
    expect(re.test(`https://ordinals.com/inscription/${ID}`)).toBe(false);
    expect(re.test(`https://evil.com/content/${ID}`)).toBe(false);
    // dot must be escaped: ordinalsXcom must NOT match
    expect(re.test(`https://ordinalsxcom/content/${ID}`)).toBe(false);
    expect(rule.action.redirect?.regexSubstitution).toContain('viewer.html#gw:');
  });
});
